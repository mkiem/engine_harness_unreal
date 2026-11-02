/**
 * The harness as an MCP server: the tools a game-dev agent (goose, Claude Code, any MCP client) calls while it works in
 * the person's own Blender and Unreal. The agent and its subagents are the workers; this server keeps them honest:
 * it plans, checks every asset against its contract, and holds file locks shared by every session on the machine.
 *
 * Every tool answers with plain text a model reads well, and with structured JSON for clients that use it.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { checkAsset, checkDelivery } from '../contracts/index.ts'
import { PREFIX, COLLISION_PREFIXES, TEXTURE_SUFFIX } from '../contracts/naming.ts'
import { readWav } from '../contracts/wav.ts'
import { AssetKind, AssetRecord, AssetSpec, WorkerResult, type Plan } from '../core/model.ts'
import { parsePlan, PlanError, waves } from '../core/plan.ts'
import { RunStore } from '../core/store.ts'
import { FileLockBackend } from '../locks/index.ts'
import { propPlan, PropBrief } from '../planner/index.ts'
import { checkSetup, configureUnrealProject, findBlenders, findProjects, installBlenderAddon, systemEnv, type SetupEnv } from '../setup/index.ts'
import { formatResult, NOT_FOUND, playInEditorScript, readEditorLog, runScriptFile, UnrealBridge } from '../unreal/bridge.ts'
import { configurePixelArt, findGodot, findGodotProject, formatErrors, GodotBridge, listScripts, readProjectName, resToPath } from '../godot/bridge.ts'
import { findNode, parseTscn, sceneTree } from '../godot/tscn.ts'

export interface HarnessServerOptions {
  /** The game project the agent works in; plans, ticket directories and the lock file live under <project>/.harness. */
  projectDir: string
  /** Shared lock store; defaults to <project>/.harness/locks.json. */
  locks?: FileLockBackend
  /** The connection to the open Unreal Editor; one per server. */
  unreal?: UnrealBridge
  /** The machine the setup tools inspect; tests pass a fake one. */
  setup?: SetupEnv
  /** Where the DCC scripts are (dcc/ in this repository, or the app's resources). */
  dccDir?: string
  /** Runs Godot; tests pass one with a fake process runner. */
  godot?: GodotBridge
  /** The engines whose tools to offer; fewer tools, less context. Defaults to HARNESS_ENGINES, else both. */
  engines?: ('unreal' | 'godot')[]
}

export function enginesFromEnv(value = process.env.HARNESS_ENGINES): ('unreal' | 'godot')[] {
  const wanted = (value ?? 'unreal,godot').split(',').map(item => item.trim().toLowerCase())
  const engines = (['unreal', 'godot'] as const).filter(engine => wanted.includes(engine))
  return engines.length ? [...engines] : ['unreal', 'godot']
}

/** HARNESS_DCC_DIR if set; else dcc/ beside the bundle (the app's payload), else dcc/ in a checkout (src/mcp/../../dcc). */
export function defaultDccDir(): string {
  if (process.env.HARNESS_DCC_DIR) return process.env.HARNESS_DCC_DIR
  const here = dirname(fileURLToPath(import.meta.url))
  for (const candidate of [join(here, 'dcc'), join(here, '..', '..', 'dcc')]) if (existsSync(candidate)) return resolve(candidate)
  return resolve(here, '..', '..', 'dcc')
}

const text = (body: string, structured?: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: body }],
  ...(structured ? { structuredContent: structured } : {}),
})
const failure = (body: string) => ({ content: [{ type: 'text' as const, text: body }], isError: true })

export function createHarnessServer(options: HarnessServerOptions): McpServer {
  const root = resolve(options.projectDir)
  const harnessDir = join(root, '.harness')
  const locks = options.locks ?? new FileLockBackend(join(harnessDir, 'locks.json'))
  const unreal = options.unreal ?? new UnrealBridge()
  const sys = options.setup ?? systemEnv()
  const dccDir = options.dccDir ?? defaultDccDir()
  const engines = options.engines ?? enginesFromEnv()
  let godotPath: string | undefined | null = null
  const godotBinary = () => {
    if (godotPath === null) godotPath = findGodot(sys)[0]?.path
    return godotPath
  }
  const godot = options.godot ?? new GodotBridge({ godot: godotBinary })
  const godotProject = () => {
    const project = findGodotProject(root)
    if (!project) throw new Error(`no project.godot in ${root} or the folders directly below it`)
    return project
  }
  const within = (path: string) => (isAbsolute(path) ? path : resolve(root, path))
  const planPath = (id: string) => join(harnessDir, 'plans', `${id}.json`)
  const loadPlan = (ref: string): Plan => {
    const path = existsSync(within(ref)) ? within(ref) : planPath(ref)
    if (!existsSync(path)) throw new Error(`no plan ${ref} (looked for ${path})`)
    return parsePlan(JSON.parse(readFileSync(path, 'utf8')))
  }
  const savePlan = (plan: Plan) => {
    mkdirSync(join(harnessDir, 'plans'), { recursive: true })
    writeFileSync(planPath(plan.id), `${JSON.stringify(plan, null, 2)}\n`)
    return planPath(plan.id)
  }
  const describePlan = (plan: Plan) => [
    `Plan ${plan.id} (${plan.tickets.length} tickets, content root ${plan.contentRoot})`,
    ...waves(plan).map((wave, index) => `wave ${index + 1} (parallel): ${wave.join(', ')}`),
    ...plan.tickets.map(ticket => `- ${ticket.id} [${ticket.domain}] ${ticket.title}: produces ${ticket.produces.map(spec => spec.id).join(', ') || 'nothing'}${ticket.consumes.length ? `; needs ${ticket.consumes.join(', ')}` : ''}${ticket.locks.length ? `; locks ${ticket.locks.join(', ')}` : ''}`),
  ].join('\n')

  const server = new McpServer({ name: 'engine-harness', version: '0.1.0' }, {
    instructions: [
      'Game-dev pipeline tools. Before making an asset, read harness_conventions for its kind.',
      'Before editing a binary file (.blend, .uasset, .umap, .wav, .wwu), take it with harness_lock, and release it with harness_unlock when done.',
      'Before telling the person an asset is ready, run harness_validate on it and fix every violation.',
      'For a multi-part request (a prop with a mesh, textures, a sound and a Blueprint), plan it with harness_plan_prop, then do the tickets wave by wave; tickets in one wave can run in parallel subagents.',
      'The unreal_* tools drive the open Unreal Editor through Python: inspect and change the level, Blueprints and assets with unreal_python, run checked-in scripts with unreal_run_script, start Play in Editor with unreal_play_in_editor so the developer can playtest, and read unreal_log after changes.',
      'For Godot projects, read and edit .tscn and .gd files directly (they are text); use godot_scene to see a scene, godot_check after editing scripts, and godot_run to catch runtime errors or open the game for the developer to play.',
      'If Blender or Unreal does not answer, run harness_setup_check, explain what is missing, and with the developer\'s agreement fix it with harness_setup_blender or harness_setup_unreal_project.',
    ].join(' '),
  })

  server.registerTool('harness_conventions', {
    title: 'Pipeline conventions',
    description: 'The naming rules, Blender-to-Unreal interchange rules and contract checks for one asset kind (or all). Read before making an asset.',
    inputSchema: { kind: AssetKind.optional() },
    annotations: { readOnlyHint: true },
  }, async ({ kind }) => {
    const kinds = kind ? [kind] : AssetKind.options
    const lines = kinds.map(item => `- ${item}: id prefix ${PREFIX[item].join(' or ')}`)
    const mesh = !kind || kind === 'static_mesh' || kind === 'skeletal_mesh'
    const texture = !kind || kind === 'texture_set'
    return text([
      'Asset ids are Unreal object names and must carry their kind\'s prefix:', ...lines,
      ...(mesh ? ['', 'Meshes (Blender → Unreal):',
        '- Metric units, Unit Scale 1.0, model at real size in metres; export FBX with apply_scale_options=FBX_SCALE_UNITS (1 m arrives as 100 cm). Never set Unit Scale 0.01.',
        '- Apply rotation and scale on every exported object; keep the FBX exporter\'s default axes.',
        '- Pivot at the bottom centre of the bounds for props, at the world origin for characters.',
        '- The render mesh is named exactly as the asset id; LODs as <id>_LOD0..n under an LOD group.',
        `- Custom collision: ${COLLISION_PREFIXES.map(prefix => `${prefix}_<id>_NN`).join(', ')}. The name after the prefix must equal the render mesh name, or Unreal imports the hull as visible geometry. Hulls must be convex.`,
        '- Material slots named and ordered as the spec lists them; at least one UV channel.',
        '- Measure the export with dcc/blender/inspect_export.py and use its output as the asset\'s facts.'] : []),
      ...(texture ? ['', 'Textures:', ...Object.entries(TEXTURE_SUFFIX).map(([map, suffix]) => `- ${map}: <id>${suffix}`),
        '- BaseColor and Emissive are sRGB; Normal and ORM are linear. Normal maps use the DirectX convention. ORM packs occlusion, roughness, metallic in R, G, B.'] : []),
      ...(!kind || kind === 'audio_clip' ? ['', 'Audio: 48 kHz 16-bit PCM WAV by default; peak at or below -1 dBFS; RMS between -30 and -12 dBFS; loops crossfaded so the seam does not click. harness_measure_audio measures a file.'] : []),
      ...(!kind || kind === 'sprite_sheet' || kind === 'tileset' ? ['', 'Pixel art (Godot 2D):',
        '- 8-bit RGBA PNG, a whole grid of frames or tiles (16x16 or 32x32 are the classic RPG sizes), one row per animation and direction.',
        '- A limited palette (the spec\'s maxColors) and hard-edged transparency: every pixel fully opaque or fully transparent. No anti-aliasing, no smoothing, no scaling except by whole numbers.',
        '- Files snake_case under res://art/ (res://art/pixel_hero.png). The project should use nearest filtering and pixel snapping (harness_setup_godot_project).'] : []),
      ...(!kind || kind === 'godot_scene' ? ['', 'Godot scenes and scripts:',
        '- Scenes are text (.tscn): write and edit them directly. format=3; ext_resource ids like "1_script"; nodes listed parent before child.',
        '- Files and folders snake_case (res://characters/pixel_hero.tscn), node names PascalCase, one script per scene root with the same base name.',
        '- GDScript with static types (var speed: float = 60.0), signals for events, @export for tunables. Run godot_check after editing, then godot_run to catch runtime errors.',
        '- 2D characters: CharacterBody2D root, AnimatedSprite2D with SpriteFrames, CollisionShape2D sized to the feet; velocity + move_and_slide().'] : []),
    ].join('\n'))
  })

  server.registerTool('harness_plan_prop', {
    title: 'Plan an interactive prop',
    description: 'Turns a structured prop brief into a checked plan of tickets (model, texture, audio, Blueprint and placement, QA) with their asset specs, dependencies and locks, and saves it under .harness/plans.',
    inputSchema: { brief: PropBrief },
  }, async ({ brief }) => {
    try {
      const plan = propPlan(brief)
      const path = savePlan(plan)
      return text(`${describePlan(plan)}\n\nSaved to ${path}. Use harness_ticket to read a ticket's full specs.`, { planId: plan.id, path, waves: waves(plan) })
    } catch (error) {
      return failure(error instanceof PlanError ? error.message : `the brief is invalid: ${(error as Error).message}`)
    }
  })

  server.registerTool('harness_plan_save', {
    title: 'Check and save a plan',
    description: 'Checks a plan you wrote (tickets wired by the assets they produce and consume) and saves it. Returns every problem at once if it is invalid.',
    inputSchema: { plan: z.record(z.string(), z.unknown()) },
  }, async ({ plan }) => {
    try {
      const parsed = parsePlan(plan)
      return text(`${describePlan(parsed)}\n\nSaved to ${savePlan(parsed)}.`, { planId: parsed.id })
    } catch (error) {
      return failure((error as Error).message)
    }
  })

  server.registerTool('harness_ticket', {
    title: 'Read a ticket',
    description: 'The full instructions, asset specs, inputs and locks of one ticket in a saved plan, and the directory to work in.',
    inputSchema: { plan: z.string().describe('plan id or path'), ticket: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ plan: ref, ticket: id }) => {
    try {
      const plan = loadPlan(ref)
      const ticket = plan.tickets.find(item => item.id === id)
      if (!ticket) return failure(`no ticket ${id} in plan ${plan.id}; tickets: ${plan.tickets.map(item => item.id).join(', ')}`)
      const dir = new RunStore(join(harnessDir, plan.id)).ticketDir(ticket.id)
      return text(`Work in ${dir}. Write result.json there when done, then run harness_validate.\n\n${JSON.stringify(ticket, null, 2)}`, { ticket, dir })
    } catch (error) {
      return failure((error as Error).message)
    }
  })

  server.registerTool('harness_validate', {
    title: 'Check assets against their contract',
    description: 'Checks delivered assets against the specs a ticket promised, using measured facts and the files themselves. Pass the result inline, or omit it to read result.json from the ticket directory. Fix every violation before saying an asset is ready.',
    inputSchema: {
      plan: z.string().describe('plan id or path'),
      ticket: z.string(),
      dir: z.string().optional().describe('ticket directory; defaults to the one harness_ticket gives'),
      result: z.record(z.string(), z.unknown()).optional().describe('the result.json content: status, summary, assets'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ plan: ref, ticket: id, dir, result }) => {
    try {
      const plan = loadPlan(ref)
      const ticket = plan.tickets.find(item => item.id === id)
      if (!ticket) return failure(`no ticket ${id} in plan ${plan.id}`)
      const ticketDir = dir ? within(dir) : new RunStore(join(harnessDir, plan.id)).ticketDir(ticket.id)
      const resultPath = join(ticketDir, 'result.json')
      const raw = result ?? (existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) as unknown : undefined)
      if (!raw) return failure(`no result given and no ${resultPath}`)
      const parsed = WorkerResult.safeParse(raw)
      if (!parsed.success) return failure(`the result does not match the report shape:\n${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('\n')}`)
      const delivered = parsed.data
      const { violations } = checkDelivery(ticket, delivered, { dir: ticketDir, projectDir: findGodotProject(root) })
      if (!violations.length) return text(`✓ ${ticket.id}: every asset passes its contract (${delivered.assets.map(asset => asset.id).join(', ')}).`, { ok: true, violations: [] })
      return text(`✗ ${ticket.id}: ${violations.length} violation(s). Fix each, then validate again:\n${violations.map(v => `- [${v.rule}] ${v.asset}: ${v.message}`).join('\n')}`, { ok: false, violations })
    } catch (error) {
      return failure((error as Error).message)
    }
  })

  server.registerTool('harness_check_asset', {
    title: 'Check one asset against a spec',
    description: 'Checks a single asset record against a spec, without a plan; for quick iteration in Blender or Unreal.',
    // spec and record are checked in the handler: their full JSON schema would cost every session ~2,000 tokens.
    inputSchema: {
      spec: z.record(z.string(), z.unknown()).describe('an asset spec, as in a plan ticket\'s produces'),
      record: z.record(z.string(), z.unknown()).describe('the delivered asset: id, kind, files, facts, provenance'),
      dir: z.string().describe('directory the record\'s relative paths resolve against'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ spec: rawSpec, record: rawRecord, dir }) => {
    const spec = AssetSpec.safeParse(rawSpec)
    const record = AssetRecord.safeParse(rawRecord)
    if (!spec.success || !record.success) {
      const issues = [...(spec.success ? [] : spec.error.issues.map(i => `spec.${i.path.join('.')}: ${i.message}`)), ...(record.success ? [] : record.error.issues.map(i => `record.${i.path.join('.')}: ${i.message}`))]
      return failure(`invalid input:\n${issues.join('\n')}`)
    }
    const { violations } = checkAsset(spec.data, record.data, { dir: within(dir), projectDir: findGodotProject(root) })
    return violations.length
      ? text(violations.map(v => `- [${v.rule}] ${v.message}`).join('\n'), { ok: false, violations })
      : text(`✓ ${spec.data.id} passes its contract.`, { ok: true, violations: [] })
  })

  server.registerTool('harness_measure_audio', {
    title: 'Measure a WAV file',
    description: 'Sample rate, channels, bit depth, length, peak and RMS level in dBFS, and the jump at the loop seam, measured from the file.',
    inputSchema: { path: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ path }) => {
    try {
      const facts = readWav(readFileSync(within(path)))
      return text(Object.entries(facts).map(([key, value]) => `${key}: ${typeof value === 'number' ? Number(value.toFixed(3)) : value}`).join('\n'), { ...facts })
    } catch (error) {
      return failure((error as Error).message)
    }
  })

  server.registerTool('harness_lock', {
    title: 'Lock files before editing',
    description: 'Takes every listed file for an owner, or none of them: binary assets cannot be merged, so take a lock before editing a .blend, .uasset, .umap, .wav or .wwu. Answers who holds a file that is taken.',
    inputSchema: { paths: z.array(z.string()).min(1), owner: z.string().describe('who holds it: a ticket id or a short task name') },
  }, async ({ paths, owner }) => {
    const sorted = [...new Set(paths)].sort()
    const taken: string[] = []
    const already = new Set(locks.list().filter(lock => lock.owner === owner).map(lock => lock.path))
    for (const path of sorted) {
      const result = locks.acquire(path, owner)
      if (!result.ok) {
        for (const done of taken) if (!already.has(done)) locks.release(done, owner)
        return failure(`${path} is locked by ${result.holder}; nothing was locked. Wait, or ask the person to release it.`)
      }
      taken.push(path)
    }
    return text(`Locked for ${owner}: ${sorted.join(', ')}`, { locked: sorted })
  })

  server.registerTool('harness_unlock', {
    title: 'Release locks',
    description: 'Releases an owner\'s locks: the listed paths, or all of them.',
    inputSchema: { owner: z.string(), paths: z.array(z.string()).optional() },
  }, async ({ owner, paths }) => {
    const mine = locks.list().filter(lock => lock.owner === owner && (!paths || paths.includes(lock.path)))
    for (const lock of mine) locks.release(lock.path, owner)
    return text(mine.length ? `Released: ${mine.map(lock => lock.path).join(', ')}` : `${owner} held none of those locks.`, { released: mine.map(lock => lock.path) })
  })

  server.registerTool('harness_locks', {
    title: 'List locks',
    description: 'Every file currently locked on this machine, by whom and since when.',
    annotations: { readOnlyHint: true },
  }, async () => {
    const held = locks.list()
    return text(held.length ? held.map(lock => `${lock.path}: ${lock.owner} since ${lock.at}`).join('\n') : 'No files are locked.', { locks: held })
  })

  // ---- DCC scripts -----------------------------------------------------------------------------------------------

  server.registerTool('harness_scripts', {
    title: 'Pipeline scripts',
    description: 'The checked-in scripts that export, inspect and import assets the same way every time (Blender export and inspection, Unreal import and inspection, Wwise import, audio synthesis), with their absolute paths and how to run each.',
    annotations: { readOnlyHint: true },
  }, async () => {
    const scripts: { path: string; summary: string }[] = []
    for (const folder of ['blender', 'unreal', 'wwise', 'audio']) {
      const dir = join(dccDir, folder)
      if (!existsSync(dir)) continue
      for (const name of readdirSync(dir).filter(file => file.endsWith('.py')).sort()) {
        const path = join(dir, name)
        const doc = /^"""([\s\S]*?)"""/.exec(readFileSync(path, 'utf8'))?.[1]?.trim() ?? ''
        scripts.push({ path, summary: doc.split(/\n\s*\n/).slice(0, 2).join('\n') })
      }
    }
    if (!scripts.length) return failure(`no scripts found in ${dccDir}`)
    return text(scripts.map(script => `## ${relative(dccDir, script.path)}\n${script.path}\n${script.summary}`).join('\n\n'), { dccDir, scripts })
  })

  // ---- Unreal Editor ---------------------------------------------------------------------------------------------
  if (engines.includes('unreal')) {

  const editorError = (error: unknown) => failure((error as Error).message || NOT_FOUND)

  server.registerTool('unreal_status', {
    title: 'Unreal Editor status',
    description: 'Which Unreal Editors are open on this machine and answering (project, engine version), and which one commands go to.',
    inputSchema: { project: z.string().optional().describe('project name or folder, when several editors are open') },
    annotations: { readOnlyHint: true },
  }, async ({ project }) => {
    try {
      const editors = await unreal.editors()
      if (!editors.length) return failure(NOT_FOUND)
      const target = await unreal.connect(project).catch(error => error as Error)
      const lines = editors.map(editor => `- ${editor.projectName} (UE ${editor.engineVersion}) at ${editor.projectRoot}`)
      return text([`Open editors:`, ...lines, target instanceof Error ? target.message : `Commands go to ${target.projectName}.`].join('\n'), { editors })
    } catch (error) {
      return editorError(error)
    }
  })

  server.registerTool('unreal_python', {
    title: 'Run Python in the Unreal Editor',
    description: 'Runs Python in the open Unreal Editor (the `unreal` module) and returns what it printed. Use it to inspect and change levels, actors, assets and Blueprints. Prefer EditorActorSubsystem, EditorAssetLibrary, AssetToolsHelpers and the other editor subsystems; save what you change.',
    inputSchema: {
      code: z.string(),
      mode: z.enum(['ExecuteFile', 'ExecuteStatement', 'EvaluateStatement']).optional().describe('ExecuteFile (default) runs a script; EvaluateStatement returns one expression\'s value'),
      project: z.string().optional(),
    },
  }, async ({ code, mode, project }) => {
    try {
      const result = await unreal.run(code, { mode, project })
      return result.success ? text(formatResult(result), { success: true }) : { ...text(formatResult(result), { success: false }), isError: true }
    } catch (error) {
      return editorError(error)
    }
  })

  server.registerTool('unreal_run_script', {
    title: 'Run a script file in the Unreal Editor',
    description: 'Runs a Python script file inside the open Unreal Editor with sys.argv set, such as dcc/unreal/import_pipeline.py --job <job.json> or dcc/unreal/inspect_asset.py blueprint /Game/Props/X/BP_X (see harness_scripts).',
    inputSchema: { path: z.string(), args: z.array(z.string()).default([]), project: z.string().optional() },
  }, async ({ path, args, project }) => {
    const full = isAbsolute(path) ? path : existsSync(resolve(dccDir, path)) ? resolve(dccDir, path) : existsSync(resolve(dccDir, '..', path)) ? resolve(dccDir, '..', path) : within(path)
    if (!existsSync(full)) return failure(`no script at ${full}`)
    try {
      const result = await unreal.run(runScriptFile(full.replace(/\\/g, '/'), args), { project })
      return result.success ? text(formatResult(result), { success: true }) : { ...text(formatResult(result), { success: false }), isError: true }
    } catch (error) {
      return editorError(error)
    }
  })

  server.registerTool('unreal_play_in_editor', {
    title: 'Play in Editor',
    description: 'Starts or stops Play in Editor, or reports whether it is running. Start it when a change is ready for the developer to playtest; stop it before changing assets or Blueprints.',
    inputSchema: { action: z.enum(['start', 'stop', 'status']), project: z.string().optional() },
  }, async ({ action, project }) => {
    try {
      const result = await unreal.run(playInEditorScript(action), { project })
      return result.success ? text(formatResult(result)) : failure(formatResult(result))
    } catch (error) {
      return editorError(error)
    }
  })

  server.registerTool('unreal_log', {
    title: 'Read the Unreal Editor log',
    description: 'The last lines of the open project\'s editor log, where Blueprint compile errors, import warnings and Play in Editor output appear. `filter` is a case-insensitive regular expression, such as "error|warning".',
    inputSchema: { lines: z.number().int().min(1).max(1000).default(80), filter: z.string().optional(), project: z.string().optional() },
    annotations: { readOnlyHint: true },
  }, async ({ lines, filter, project }) => {
    try {
      const editor = await unreal.connect(project)
      return text(readEditorLog(editor.projectRoot, editor.projectName, { lines, filter }))
    } catch (error) {
      return editorError(error)
    }
  })

  }

  // ---- First-run setup -------------------------------------------------------------------------------------------

  server.registerTool('harness_setup_check', {
    title: 'Check this machine',
    description: 'Checks what the app needs on this machine: uv, Blender and its MCP addon and connection, Unreal Engine installs, the game project\'s Python plugin and remote execution, and a running editor. Each line is ok, note or todo with the fix. Run it on first use and whenever Blender or Unreal does not answer.',
    inputSchema: { projectDir: z.string().optional().describe('the game project folder; defaults to the current project') },
    annotations: { readOnlyHint: true },
  }, async ({ projectDir }) => {
    const report = await checkSetup(sys, { projectDir: projectDir ? within(projectDir) : root, editors: () => unreal.editors(1500), godot: () => findGodot(sys), godotProject: findGodotProject })
    return text(`${report.ok ? 'Everything needed is in place.' : 'Some things need setting up:'}\n${report.lines.join('\n')}`, { ok: report.ok, lines: report.lines })
  })

  server.registerTool('harness_setup_blender', {
    title: 'Install the Blender addon',
    description: 'Installs and enables the MCP for Blender addon in one Blender (the newest found, or the given version), so the app can drive it. Changes Blender\'s user add-ons and preferences: ask the developer first.',
    inputSchema: { version: z.string().optional().describe('Blender version such as 4.3; defaults to the newest installed') },
  }, async ({ version }) => {
    const blenders = findBlenders(sys)
    const blender = version ? blenders.find(item => item.version === version) : blenders[0]
    if (!blender) return failure(blenders.length ? `no Blender ${version}; found ${blenders.map(item => item.version).join(', ')}` : 'no Blender found; install Blender 3.6 or later first')
    try {
      return text(installBlenderAddon(sys, blender, sys.platform === 'win32' ? 'uvx.exe' : 'uvx').map(step => `- ${step}`).join('\n'))
    } catch (error) {
      return failure((error as Error).message)
    }
  })

  if (engines.includes('unreal')) server.registerTool('harness_setup_unreal_project', {
    title: 'Set up an Unreal project for the editor bridge',
    description: 'Enables the Python Editor Script Plugin and Editor Scripting Utilities in the .uproject and turns on Python remote execution, keeping .bak copies. Changes project files: ask the developer first, and tell them to restart the editor.',
    inputSchema: { uproject: z.string().optional().describe('path to the .uproject; defaults to the one in the project folder') },
  }, async ({ uproject }) => {
    const target = uproject ? within(uproject) : findProjects(sys, root)[0]
    if (!target) return failure(`no .uproject found under ${root}; pass its path`)
    try {
      return text(configureUnrealProject(sys, target).map(step => `- ${step}`).join('\n'))
    } catch (error) {
      return failure((error as Error).message)
    }
  })

  // ---- Godot ------------------------------------------------------------------------------------------------------
  if (engines.includes('godot')) {

  const godotFailure = (error: unknown) => failure((error as Error).message)

  server.registerTool('godot_status', {
    title: 'Godot status',
    description: 'The Godot 4 executable found and the open Godot project.',
    annotations: { readOnlyHint: true },
  }, async () => {
    const installs = findGodot(sys)
    const project = findGodotProject(root)
    return text([
      installs.length ? `Godot ${installs[0]!.version} at ${installs[0]!.path}` : 'Godot 4 not found (install it, or set GODOT_BIN)',
      project ? `Project "${readProjectName(project)}" at ${project}` : `No project.godot in ${root}`,
    ].join('\n'), { godot: installs[0] ?? null, project: project ?? null })
  })

  server.registerTool('godot_scene', {
    title: 'Read a Godot scene',
    description: 'A .tscn scene as a compact node tree, or one node\'s properties when `node` is given (a path like "." or "Sprite" or "UI/Health").',
    inputSchema: { path: z.string().describe('res:// or project-relative .tscn path'), node: z.string().optional() },
    annotations: { readOnlyHint: true },
  }, async ({ path, node }) => {
    try {
      const project = godotProject()
      const file = path.startsWith('res://') ? resToPath(project, path) : resolve(project, path)
      if (!existsSync(file)) return failure(`no scene at ${file}`)
      const scene = parseTscn(readFileSync(file, 'utf8'))
      if (!node) return text(sceneTree(scene))
      const found = findNode(scene, node)
      if (!found) return failure(`no node ${node}; nodes: ${scene.nodes.map(item => item.parent === undefined ? '.' : item.parent === '.' ? item.name : `${item.parent}/${item.name}`).join(', ')}`)
      const props = Object.entries(found.properties).map(([key, value]) => `${key} = ${value}`)
      return text([`${found.name} (${found.type ?? 'instance'})`, ...props].join('\n'))
    } catch (error) {
      return godotFailure(error)
    }
  })

  server.registerTool('godot_check', {
    title: 'Validate GDScript',
    description: 'Parses GDScript with Godot (--check-only): the given files, or every script in the project outside addons/.',
    inputSchema: { files: z.array(z.string()).optional().describe('res:// or project-relative .gd paths') },
    annotations: { readOnlyHint: true },
  }, async ({ files }) => {
    try {
      const project = godotProject()
      const targets = files?.length ? files.map(file => file.startsWith('res://') ? file : resolve(project, file)) : listScripts(project)
      if (!targets.length) return text('No GDScript files to check.')
      const { checked, errors } = await godot.check(project, targets)
      return errors.length ? { ...text(`${errors.length} error(s) in ${checked} script(s):\n${formatErrors(errors)}`, { errors }), isError: true } : text(`✓ ${checked} script(s) parse cleanly.`, { errors: [] })
    } catch (error) {
      return godotFailure(error)
    }
  })

  server.registerTool('godot_run', {
    title: 'Run the Godot game',
    description: 'Runs the project (or one scene) headless for `seconds` and reports errors; with window: true, opens it for the developer to play instead.',
    inputSchema: { scene: z.string().optional(), seconds: z.number().min(1).max(60).default(5), window: z.boolean().default(false) },
  }, async ({ scene, seconds, window }) => {
    try {
      const project = godotProject()
      if (window) {
        const pid = godot.play(project, scene)
        return text(`Opened the game in a window${pid ? ` (pid ${pid})` : ''}. Ask the developer what they see.`)
      }
      const result = await godot.runHeadless(project, { scene, frames: Math.round(seconds * 60) })
      if (result.errors.length) return { ...text(`${result.errors.length} error(s) while running:\n${formatErrors(result.errors)}`, { errors: result.errors }), isError: true }
      return text(`Ran ${seconds} s with no errors${result.timedOut ? ' (stopped at the time limit)' : ''}.\n${result.output.split('\n').slice(-10).join('\n')}`, { errors: [] })
    } catch (error) {
      return godotFailure(error)
    }
  })

  server.registerTool('harness_setup_godot_project', {
    title: 'Pixel-art defaults for a Godot project',
    description: 'Sets crisp pixel-art defaults in project.godot (nearest filtering, pixel snapping, base resolution scaled by whole numbers), keeping a backup. Ask the developer first.',
    inputSchema: { width: z.number().int().default(320), height: z.number().int().default(180), windowScale: z.number().int().min(1).max(8).default(4) },
  }, async ({ width, height, windowScale }) => {
    try {
      return text(configurePixelArt(sys, godotProject(), { width, height, windowScale }).join('\n'))
    } catch (error) {
      return godotFailure(error)
    }
  })

  }

  return server
}
