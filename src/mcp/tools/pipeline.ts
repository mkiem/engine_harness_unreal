/**
 * Core pipeline, asset contract, file lock, DCC script, and first-run machine setup MCP tools.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { z } from 'zod'
import { checkAsset, checkDelivery } from '../../contracts/index.ts'
import { COLLISION_PREFIXES, PREFIX, TEXTURE_SUFFIX } from '../../contracts/naming.ts'
import { readWav } from '../../contracts/wav.ts'
import { AssetKind, AssetRecord, AssetSpec, WorkerResult } from '../../core/model.ts'
import { parsePlan, PlanError, waves } from '../../core/plan.ts'
import { RunStore } from '../../core/store.ts'
import { findGodot, findGodotProject } from '../../godot/bridge.ts'
import { PropBrief, propPlan } from '../../planner/index.ts'
import { checkSetup, findBlenders, installBlenderAddon } from '../../setup/index.ts'
import { failure, text, type HarnessContext } from '../context.ts'

export function registerPipelineTools(ctx: HarnessContext): void {
  const { server, root, harnessDir, locks, unreal, sys, dccDir, within, loadPlan, savePlan, describePlan, track } = ctx

  track('pipeline', server.registerTool('harness_conventions', {
    title: 'Pipeline conventions',
    description: 'The naming rules, Blender-to-Unreal interchange rules and contract checks for one asset kind (or all). Read before making an asset.',
    inputSchema: { kind: AssetKind.optional() },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async ({ kind }) => {
    const kinds = kind ? [kind] : AssetKind.options
    const lines = kinds.map(item => `- ${item}: id prefix ${PREFIX[item].join(' or ')}`)
    const mesh = !kind || kind === 'static_mesh' || kind === 'skeletal_mesh'
    const texture = !kind || kind === 'texture_set'
    return text([
      'Asset ids are Unreal object names and must carry their kind\'s prefix:', ...lines,
      ...(mesh ? ['', 'Meshes (Blender → Unreal):',
        '- Metric units, Unit Scale 1.0, model at real size in metres; export FBX with apply_scale_options=FBX_SCALE_UNITS (1 m arrives as 100 cm) or glTF/GLB for UE 5.5+ Interchange. Never set Unit Scale 0.01.',
        '- Apply rotation and scale on every exported object; keep the exporter\'s default axes.',
        '- Pivot at the bottom centre of the bounds for props, at the world origin for characters.',
        '- The render mesh is named exactly as the asset id; LODs as <id>_LOD0..n under an LOD group.',
        `- Custom collision: ${COLLISION_PREFIXES.map(prefix => `${prefix}_<id>_NN`).join(', ')}. The name after the prefix must equal the render mesh name, or Unreal imports the hull as visible geometry. Hulls must be convex.`,
        '- Material slots named and ordered as the spec lists them; at least one UV channel.',
        '- Measure the export with dcc/blender/inspect_export.py and use its output as the asset\'s facts.'] : []),
      ...(texture ? ['', 'Textures:', ...Object.entries(TEXTURE_SUFFIX).map(([map, suffix]) => `- ${map}: <id>${suffix}`),
        '- BaseColor and Emissive are sRGB; Normal and ORM are linear. Normal maps use the DirectX convention. ORM packs occlusion, roughness, metallic in R, G, B.'] : []),
      ...(!kind || kind === 'audio_clip' ? ['', 'Audio: 48 kHz 16-bit PCM WAV by default; peak at or below -1 dBFS (and true peak <= -1 dBTP); integrated loudness (ITU-R BS.1770 LUFS) and RMS within spec (-30 to -12 dBFS); loops crossfaded so the seam does not click. harness_measure_audio measures a file.'] : []),
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
  }))

  track('pipeline', server.registerTool('harness_plan_prop', {
    title: 'Plan an interactive prop',
    description: 'Turns a structured prop brief into a checked plan of tickets (model, texture, audio, Blueprint and placement, QA) with their asset specs, dependencies and locks, and saves it under .harness/plans.',
    inputSchema: { brief: PropBrief },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ brief }) => {
    try {
      const plan = propPlan(brief)
      const path = savePlan(plan)
      return text(`${describePlan(plan)}\n\nSaved to ${path}. Use harness_ticket to read a ticket's full specs.`, { planId: plan.id, path, waves: waves(plan) })
    } catch (error) {
      return failure(error instanceof PlanError ? error.message : `the brief is invalid: ${(error as Error).message}`)
    }
  }))

  track('pipeline', server.registerTool('harness_plan_save', {
    title: 'Check and save a plan',
    description: 'Checks a plan you wrote (tickets wired by the assets they produce and consume) and saves it. Returns every problem at once if it is invalid.',
    inputSchema: { plan: z.record(z.string(), z.unknown()) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ plan }) => {
    try {
      const parsed = parsePlan(plan)
      return text(`${describePlan(parsed)}\n\nSaved to ${savePlan(parsed)}.`, { planId: parsed.id })
    } catch (error) {
      return failure((error as Error).message)
    }
  }))

  track('pipeline', server.registerTool('harness_ticket', {
    title: 'Read a ticket',
    description: 'The full instructions, asset specs, inputs and locks of one ticket in a saved plan, and the directory to work in.',
    inputSchema: { plan: z.string().describe('plan id or path'), ticket: z.string() },
    annotations: { readOnlyHint: true, idempotentHint: true },
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
  }))

  track('pipeline', server.registerTool('harness_validate', {
    title: 'Check assets against their contract',
    description: 'Checks delivered assets against the specs a ticket promised, using measured facts and the files themselves. Pass the result inline, or omit it to read result.json from the ticket directory. Fix every violation before saying an asset is ready.',
    inputSchema: {
      plan: z.string().describe('plan id or path'),
      ticket: z.string(),
      dir: z.string().optional().describe('ticket directory; defaults to the one harness_ticket gives'),
      result: z.record(z.string(), z.unknown()).optional().describe('the result.json content: status, summary, assets'),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
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
  }))

  track('pipeline', server.registerTool('harness_check_asset', {
    title: 'Check one asset against a spec',
    description: 'Checks a single asset record against a spec, without a plan; for quick iteration in Blender or Unreal.',
    inputSchema: {
      spec: z.record(z.string(), z.unknown()).describe('an asset spec, as in a plan ticket\'s produces'),
      record: z.record(z.string(), z.unknown()).describe('the delivered asset: id, kind, files, facts, provenance'),
      dir: z.string().describe('directory the record\'s relative paths resolve against'),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
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
  }))

  track('pipeline', server.registerTool('harness_measure_audio', {
    title: 'Measure a WAV file',
    description: 'Sample rate, channels, bit depth, length, peak, true peak, RMS, ITU-R BS.1770 integrated LUFS, and the jump at the loop seam, measured from the file.',
    inputSchema: { path: z.string() },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async ({ path }) => {
    try {
      const facts = readWav(readFileSync(within(path)))
      return text(Object.entries(facts).map(([key, value]) => `${key}: ${typeof value === 'number' ? Number(value.toFixed(3)) : value}`).join('\n'), { ...facts })
    } catch (error) {
      return failure((error as Error).message)
    }
  }))

  track('pipeline', server.registerTool('harness_lock', {
    title: 'Lock files before editing',
    description: 'Takes every listed file for an owner, or none of them: binary assets cannot be merged, so take a lock before editing a .blend, .uasset, .umap, .wav or .wwu. Answers who holds a file that is taken.',
    inputSchema: { paths: z.array(z.string()).min(1), owner: z.string().describe('who holds it: a ticket id or a short task name') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
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
  }))

  track('pipeline', server.registerTool('harness_unlock', {
    title: 'Release locks',
    description: 'Releases an owner\'s locks: the listed paths, or all of them.',
    inputSchema: { owner: z.string(), paths: z.array(z.string()).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ owner, paths }) => {
    const mine = locks.list().filter(lock => lock.owner === owner && (!paths || paths.includes(lock.path)))
    for (const lock of mine) locks.release(lock.path, owner)
    return text(mine.length ? `Released: ${mine.map(lock => lock.path).join(', ')}` : `${owner} held none of those locks.`, { released: mine.map(lock => lock.path) })
  }))

  track('pipeline', server.registerTool('harness_locks', {
    title: 'List locks',
    description: 'Every file currently locked on this machine, by whom and since when.',
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async () => {
    const held = locks.list()
    return text(held.length ? held.map(lock => `${lock.path}: ${lock.owner} since ${lock.at}`).join('\n') : 'No files are locked.', { locks: held })
  }))

  track('pipeline', server.registerTool('harness_scripts', {
    title: 'Pipeline scripts',
    description: 'The checked-in scripts that export, inspect and import assets the same way every time (Blender export and inspection, Unreal import and inspection, Wwise import, audio synthesis), with their absolute paths and how to run each.',
    annotations: { readOnlyHint: true, idempotentHint: true },
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
    return text(scripts.map(script => `## ${relative(dccDir, script.path).replace(/\\/g, '/')}\n${script.path.replace(/\\/g, '/')}\n${script.summary}`).join('\n\n'), { dccDir, scripts })
  }))

  track('pipeline', server.registerTool('harness_setup_check', {
    title: 'Check this machine',
    description: 'Checks what the app needs on this machine: uv, Blender and its MCP addon and connection, Unreal Engine installs, the game project\'s Python plugin and remote execution, and a running editor. Each line is ok, note or todo with the fix. Run it on first use and whenever Blender or Unreal does not answer.',
    inputSchema: { projectDir: z.string().optional().describe('the game project folder; defaults to the current project') },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async ({ projectDir }) => {
    const report = await checkSetup(sys, { projectDir: projectDir ? within(projectDir) : root, editors: () => unreal.editors(1500), godot: () => findGodot(sys), godotProject: findGodotProject })
    return text(`${report.ok ? 'Everything needed is in place.' : 'Some things need setting up:'}\n${report.lines.join('\n')}`, { ok: report.ok, lines: report.lines })
  }))

  track('pipeline', server.registerTool('harness_setup_blender', {
    title: 'Install the Blender addon',
    description: 'Installs and enables the MCP for Blender addon in one Blender (the newest found, or the given version), so the app can drive it. Changes Blender\'s user add-ons and preferences: ask the developer first.',
    inputSchema: { version: z.string().optional().describe('Blender version such as 4.3; defaults to the newest installed') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ version }) => {
    const blenders = findBlenders(sys)
    const blender = version ? blenders.find(item => item.version === version) : blenders[0]
    if (!blender) return failure(blenders.length ? `no Blender ${version}; found ${blenders.map(item => item.version).join(', ')}` : 'no Blender found; install Blender 3.6 or later first')
    try {
      return text(installBlenderAddon(sys, blender, sys.platform === 'win32' ? 'uvx.exe' : 'uvx').map(step => `- ${step}`).join('\n'))
    } catch (error) {
      return failure((error as Error).message)
    }
  }))
}

