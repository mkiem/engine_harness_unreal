/**
 * The harness as an MCP server: the tools a game-dev agent (goose, Claude Code, any MCP client) calls while it works in
 * the person's own Blender and Unreal. The agent and its subagents are the workers; this server keeps them honest:
 * it plans, checks every asset against its contract, and holds file locks shared by every session on the machine.
 *
 * Every tool answers with plain text a model reads well, and with structured JSON for clients that use it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
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

export interface HarnessServerOptions {
  /** The game project the agent works in; plans, ticket directories and the lock file live under <project>/.harness. */
  projectDir: string
  /** Shared lock store; defaults to <project>/.harness/locks.json. */
  locks?: FileLockBackend
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
      result: WorkerResult.optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ plan: ref, ticket: id, dir, result }) => {
    try {
      const plan = loadPlan(ref)
      const ticket = plan.tickets.find(item => item.id === id)
      if (!ticket) return failure(`no ticket ${id} in plan ${plan.id}`)
      const ticketDir = dir ? within(dir) : new RunStore(join(harnessDir, plan.id)).ticketDir(ticket.id)
      const resultPath = join(ticketDir, 'result.json')
      const delivered = result ?? (existsSync(resultPath) ? WorkerResult.parse(JSON.parse(readFileSync(resultPath, 'utf8'))) : undefined)
      if (!delivered) return failure(`no result given and no ${resultPath}`)
      const { violations } = checkDelivery(ticket, delivered, { dir: ticketDir })
      if (!violations.length) return text(`✓ ${ticket.id}: every asset passes its contract (${delivered.assets.map(asset => asset.id).join(', ')}).`, { ok: true, violations: [] })
      return text(`✗ ${ticket.id}: ${violations.length} violation(s). Fix each, then validate again:\n${violations.map(v => `- [${v.rule}] ${v.asset}: ${v.message}`).join('\n')}`, { ok: false, violations })
    } catch (error) {
      return failure((error as Error).message)
    }
  })

  server.registerTool('harness_check_asset', {
    title: 'Check one asset against a spec',
    description: 'Checks a single asset record against a spec, without a plan; for quick iteration in Blender or Unreal.',
    inputSchema: { spec: AssetSpec, record: AssetRecord, dir: z.string().describe('directory the record\'s relative paths resolve against') },
    annotations: { readOnlyHint: true },
  }, async ({ spec, record, dir }) => {
    const { violations } = checkAsset(spec, record, { dir: within(dir) })
    return violations.length
      ? text(violations.map(v => `- [${v.rule}] ${v.message}`).join('\n'), { ok: false, violations })
      : text(`✓ ${spec.id} passes its contract.`, { ok: true, violations: [] })
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

  return server
}
