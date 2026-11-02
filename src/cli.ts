#!/usr/bin/env node
/** harness: plan a brief, run the plan through workers, and act on what waits for a person. */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { checkDelivery } from './contracts/index.ts'
import { WorkerResult, type Domain, type Plan, type PlanRun, type RunEvent } from './core/model.ts'
import { Orchestrator, PERSON_STATES } from './core/orchestrator.ts'
import { parsePlan, PlanError, waves } from './core/plan.ts'
import { Pools } from './core/pools.ts'
import type { Executor, Ingestor } from './core/ports.ts'
import { RunStore } from './core/store.ts'
import { AgentCliExecutor } from './executors/agent-cli.ts'
import { gooseExecutor } from './executors/goose.ts'
import { SimulatedExecutor } from './executors/simulated.ts'
import { SimulatedIngestor, UnrealCommandletIngestor } from './ingest/index.ts'
import { GitLfsLockBackend, LockManager, MemoryLockBackend, PerforceLockBackend, type LockBackend } from './locks/index.ts'
import { LlmPlanner, OpenAICompatibleModel, propPlan } from './planner/index.ts'
import { loadPresets, loadProfile, resolvePreset, type Preset, type Profile } from './presets/index.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_PROFILE: Profile = { name: 'default', os: 'linux', vars: {}, pools: {}, locks: { backend: 'memory' } }

const USAGE = `harness <command>

  plan prop <brief.json> [-o plan.json]     Plan an interactive prop from a structured brief (no model)
  plan llm "<brief>" [-o plan.json]         Plan from free text with an OpenAI-compatible model
                                            (HARNESS_PLANNER_API_KEY, HARNESS_PLANNER_BASE_URL, HARNESS_PLANNER_MODEL)
  plan check <plan.json>                    Check a plan and show its parallel waves

  run <plan.json> [options]                 Run a plan until it needs a person
      --executor simulated|agent|goose      Worker layer (default simulated)
      --ingest simulated|unreal|none        Engine ingest stage (default simulated)
      --profile <profile.json>              Machine profile: paths, pool sizes, lock backend, agent command
      --state <dir>                         Run state directory (default .harness/<plan id>)
      --sim-faults                          Simulated workers make typical mistakes on their first revision
      --fresh                               Discard stored state for this plan first
  status [--state <dir>]                    What each ticket is doing, and what waits for a person
  approve <ticket> [note] [--state <dir>]   Approve a ticket's assets after review
  answer <ticket> [text] [--state <dir>]    Answer a question, ask for changes, or retry

  validate --plan <plan.json> --ticket <id> --dir <dir>
                                            Check a worker's result.json against its contract (workers run this too)
  presets [--profile <profile.json>]        Resolve every preset on a profile; list missing variables
  probe [--profile <profile.json>]          Check which DCC endpoints answer (Blender socket, WAAPI, Unreal MCP)
`

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' }, executor: { type: 'string', default: 'simulated' }, ingest: { type: 'string', default: 'simulated' },
      profile: { type: 'string' }, state: { type: 'string' }, 'sim-faults': { type: 'boolean', default: false }, fresh: { type: 'boolean', default: false },
      plan: { type: 'string' }, ticket: { type: 'string' }, dir: { type: 'string' }, delay: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    },
  })
  const [command, sub, ...rest] = positionals
  if (values.help || !command) return print(USAGE), command ? 0 : 1
  const profile = values.profile ? loadProfile(values.profile) : DEFAULT_PROFILE
  const presets = loadPresets(join(ROOT, 'presets'))

  switch (command) {
    case 'plan': {
      let plan: Plan
      if (sub === 'prop' && rest[0]) plan = propPlan(JSON.parse(readFileSync(rest[0], 'utf8')))
      else if (sub === 'llm' && rest.length) {
        const model = new OpenAICompatibleModel({ apiKey: process.env.HARNESS_PLANNER_API_KEY ?? process.env.DEEPSEEK_API_KEY, baseUrl: process.env.HARNESS_PLANNER_BASE_URL, model: process.env.HARNESS_PLANNER_MODEL })
        plan = await new LlmPlanner({ model, repoRoot: ROOT }).plan(rest.join(' '))
      } else if (sub === 'check' && rest[0]) plan = parsePlan(JSON.parse(readFileSync(rest[0], 'utf8')))
      else return print(USAGE), 1
      if (values.out) writeFileSync(values.out, `${JSON.stringify(plan, null, 2)}\n`)
      else if (sub !== 'check') print(JSON.stringify(plan, null, 2))
      printWaves(plan)
      return 0
    }
    case 'run': {
      if (!sub) return print(USAGE), 1
      const plan = parsePlan(JSON.parse(readFileSync(sub, 'utf8')))
      const stateDir = values.state ?? join('.harness', plan.id)
      if (values.fresh && existsSync(stateDir)) rmSync(stateDir, { recursive: true, force: true })
      const executor = makeExecutor(values.executor!, { presets, profile, faults: values['sim-faults']!, delayMs: Number(values.delay ?? 150) })
      const orchestrator = new Orchestrator({
        plan, store: new RunStore(stateDir), executor, ingestor: makeIngestor(values.ingest!, profile),
        pools: new Pools(profile.pools), locks: new LockManager(makeLockBackend(profile)),
        poolOf: domain => poolOf(presets, domain), onEvent: printEvent,
      })
      process.once('SIGINT', () => { print('\nstopping; the run resumes where it left off next time'); orchestrator.stop() })
      const run = await orchestrator.runUntilIdle()
      printStatus(run)
      return Object.values(run.tickets).every(ticket => ticket.state === 'done') ? 0 : 2
    }
    case 'status': {
      const run = loadRun(values.state, sub)
      printStatus(run)
      return 0
    }
    case 'approve':
    case 'answer': {
      if (!sub) return print(USAGE), 1
      const run = loadRun(values.state)
      const store = new RunStore(stateDirOf(values.state, run.planId))
      const orchestrator = new Orchestrator({
        plan: run.plan, store, executor: { run: async () => { throw new Error('not running') } }, pools: new Pools(),
        locks: new LockManager(makeLockBackend(profile)), poolOf: domain => poolOf(presets, domain),
      })
      if (command === 'approve') orchestrator.approve(sub, rest.join(' ') || undefined)
      else orchestrator.answer(sub, rest.join(' ') || undefined)
      print(`${sub}: ${orchestrator.run.tickets[sub]!.state}. Run the plan again to continue.`)
      return 0
    }
    case 'validate': {
      if (!values.plan || !values.ticket || !values.dir) return print(USAGE), 1
      const plan = parsePlan(JSON.parse(readFileSync(values.plan, 'utf8')))
      const ticket = plan.tickets.find(item => item.id === values.ticket)
      if (!ticket) throw new Error(`no ticket ${values.ticket} in ${values.plan}`)
      const resultPath = join(values.dir, 'result.json')
      if (!existsSync(resultPath)) throw new Error(`${resultPath} does not exist; a worker writes it before reporting`)
      const result = WorkerResult.parse(JSON.parse(readFileSync(resultPath, 'utf8')))
      const { violations } = checkDelivery(ticket, result, { dir: resolve(values.dir) })
      if (!violations.length) return print(`${ticket.id}: contract passes for ${result.assets.map(a => a.id).join(', ')}`), 0
      for (const violation of violations) print(`✗ ${violation.rule} ${violation.asset}: ${violation.message}`)
      return 2
    }
    case 'presets': {
      let ok = true
      for (const preset of presets.values()) {
        try {
          const resolved = resolvePreset(preset, profile)
          print(`✓ ${preset.name} (${preset.domain}, pool ${preset.pool}×${profile.pools[preset.pool] ?? 1}): MCP ${Object.keys(resolved.mcpConfig.mcpServers).join(', ') || 'none'}`)
        } catch (error) {
          ok = false
          print(`✗ ${preset.name}: ${(error as Error).message}`)
        }
      }
      return ok ? 0 : 2
    }
    case 'probe': {
      const vars = { ...process.env, ...profile.vars } as Record<string, string | undefined>
      const endpoints: [string, string | undefined, string | undefined][] = [
        ['Blender (blender-mcp addon)', vars.BLENDER_HOST ?? '127.0.0.1', vars.BLENDER_PORT ?? '9876'],
        ['Wwise (WAAPI)', ...hostPort(vars.WAAPI_URL ?? 'ws://127.0.0.1:8080/waapi')],
        ['Unreal (MCP)', ...hostPort(vars.UNREAL_MCP_URL ?? 'http://127.0.0.1:8000/mcp')],
      ]
      for (const [name, host, port] of endpoints) print(`${await reachable(host!, Number(port)) ? '✓' : '✗'} ${name} at ${host}:${port}`)
      return 0
    }
    default:
      print(USAGE)
      return 1
  }
}

function makeExecutor(kind: string, options: { presets: Map<Domain, Preset>; profile: Profile; faults: boolean; delayMs: number }): Executor {
  switch (kind) {
    case 'simulated': return new SimulatedExecutor({ faults: options.faults, delayMs: options.delayMs })
    case 'agent': return new AgentCliExecutor({ presets: options.presets, profile: options.profile, repoRoot: ROOT })
    case 'goose': return gooseExecutor({ presets: options.presets, profile: options.profile, repoRoot: ROOT })
    default: throw new Error(`unknown executor ${kind}`)
  }
}

function makeIngestor(kind: string, profile: Profile): Ingestor | undefined {
  if (kind === 'none') return undefined
  if (kind === 'simulated') return new SimulatedIngestor()
  if (kind === 'unreal') {
    const editorCmd = profile.vars.UNREAL_EDITOR_CMD
    const uproject = profile.vars.UNREAL_PROJECT
    if (!editorCmd || !uproject) throw new Error(`--ingest unreal needs UNREAL_EDITOR_CMD and UNREAL_PROJECT in profile ${profile.name}`)
    return new UnrealCommandletIngestor({ editorCmd, uproject, repoRoot: ROOT })
  }
  throw new Error(`unknown ingest ${kind}`)
}

function makeLockBackend(profile: Profile): LockBackend {
  switch (profile.locks.backend) {
    case 'perforce': return new PerforceLockBackend({ cwd: profile.locks.cwd })
    case 'git-lfs': return new GitLfsLockBackend({ cwd: profile.locks.cwd })
    default: return new MemoryLockBackend()
  }
}

const poolOf = (presets: Map<Domain, Preset>, domain: Domain) => presets.get(domain)?.pool ?? domain

function stateDirOf(state: string | undefined, planId?: string): string {
  if (state) return state
  if (planId) return join('.harness', planId)
  throw new Error('pass --state <dir>')
}

function loadRun(state: string | undefined, planId?: string): PlanRun {
  const dir = state ?? (planId ? join('.harness', planId) : undefined)
  if (!dir) throw new Error('pass --state <dir> or a plan id')
  const run = new RunStore(dir).load()
  if (!run) throw new Error(`no run in ${dir}`)
  return run
}

function hostPort(url: string): [string, string] {
  const parsed = new URL(url)
  return [parsed.hostname, parsed.port || (parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? '443' : '80')]
}

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise(done => {
    const socket = connect({ host, port, timeout: 1500 })
    socket.once('connect', () => { socket.destroy(); done(true) })
    socket.once('timeout', () => { socket.destroy(); done(false) })
    socket.once('error', () => done(false))
  })
}

const print = (text: string) => process.stdout.write(`${text}\n`)

function printWaves(plan: Plan) {
  waves(plan).forEach((wave, index) => print(`wave ${index + 1}: ${wave.join(', ')}`))
}

const ICON: Record<string, string> = {
  'ticket.queued': '·', 'ticket.running': '▶', 'ticket.revising': '↻', 'ticket.validating': '⧗', 'ticket.done': '✓', 'ticket.review': '👁',
  'ticket.attention': '?', 'ticket.blocked': '■', 'ticket.failed': '✗', 'ticket.dropped': '–', 'contract.violation': '  ✗', 'asset.ingested': '  ⇢',
  'locks.acquired': '  🔒', 'ticket.waiting': '  …',
}
function printEvent(event: RunEvent) {
  if (event.type.startsWith('report.')) return
  print(`${(ICON[event.type] ?? ' ').padEnd(3)} ${(event.ticketId ?? '').padEnd(24)} ${event.type.replace(/^ticket\./, '').padEnd(18)} ${event.detail}`)
}

function printStatus(run: PlanRun) {
  print(`\nplan ${run.planId}`)
  for (const ticket of Object.values(run.tickets)) {
    const delivered = Object.keys(ticket.delivered)
    print(`  ${ticket.id.padEnd(24)} ${ticket.state.padEnd(11)} ${ticket.assignments.length} assignment(s)${delivered.length ? `  ${delivered.join(', ')}` : ''}`)
  }
  const waitingForPerson = Object.values(run.tickets).filter(ticket => PERSON_STATES.includes(ticket.state))
  if (waitingForPerson.length) {
    print('\nwaiting for a person:')
    for (const ticket of waitingForPerson) print(`  ${ticket.id}: ${ticket.attention ?? ticket.state}`)
  }
  if (run.locks.length) print(`\nlocks held: ${run.locks.map(lock => `${lock.path} (${lock.ticketId})`).join(', ')}`)
}

// A closed pipe (harness status | head) is not an error.
process.stdout.on('error', error => { if ((error as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0); throw error })

main(process.argv.slice(2)).then(code => { process.exitCode = code }, error => {
  const detail = error instanceof PlanError || !process.env.HARNESS_DEBUG ? (error as Error).message : (error as Error).stack
  process.stderr.write(`harness: ${detail ?? String(error)}\n`)
  process.exitCode = 1
})
