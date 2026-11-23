// Automated harness evaluation suite: runs golden plans through the Orchestrator + Contract Gate,
// reporting first-try pass rate, mean revisions to green, total violations caught, and OTel span counts.
// Usage: node scripts/eval-harness.ts [--min-pass-rate 0.5]
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Orchestrator } from '../src/core/orchestrator.ts'
import { parsePlan } from '../src/core/plan.ts'
import { Pools } from '../src/core/pools.ts'
import { SqliteRunStore } from '../src/core/store.ts'
import { TraceCollector } from '../src/core/telemetry.ts'
import { SimulatedExecutor } from '../src/executors/simulated.ts'
import { SimulatedIngestor } from '../src/ingest/index.ts'
import { LockManager, MemoryLockBackend } from '../src/locks/index.ts'

const root = resolve(fileURLToPath(import.meta.url), '..', '..')
const cases = [
  { name: 'vintage-radio (clean)', plan: 'examples/vintage-radio/plan.json', faults: false },
  { name: 'vintage-radio (planted faults)', plan: 'examples/vintage-radio/plan.json', faults: true },
]

console.log('| Scenario | Tickets | Done | First-Try Pass | Revisions | Violations Caught | Spans |')
console.log('| --- | --- | --- | --- | --- | --- | --- |')

let failed = false
for (const c of cases) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-eval-'))
  try {
    const plan = parsePlan(JSON.parse(readFileSync(join(root, c.plan), 'utf8')))
    const store = new SqliteRunStore(dir)
    const traces = new TraceCollector({ file: join(dir, 'traces.jsonl') })
    const orch = new Orchestrator({
      plan, store, executor: new SimulatedExecutor({ injectFaults: c.faults, delayMs: 0 }),
      ingestor: new SimulatedIngestor(), pools: new Pools({ unreal: 1 }), locks: new LockManager(new MemoryLockBackend()),
      poolOf: d => d === 'unreal' || d === 'qa' ? 'unreal' : d, telemetry: traces,
    })
    let run = await orch.runUntilIdle()
    // Auto-approve human review gates during headless evaluation
    for (const ticket of Object.values(run.tickets)) {
      if (ticket.state === 'review') orch.approve(ticket.id, 'eval auto-approved')
    }
    run = await orch.runUntilIdle()
    const tickets = Object.values(run.tickets)
    const done = tickets.filter(t => t.state === 'done').length
    const firstTry = tickets.filter(t => t.assignments.length === 1 && !(t.assignments[0]?.violations?.length)).length
    const revisions = tickets.reduce((sum, t) => sum + Math.max(0, t.assignments.length - 1), 0)
    const violations = tickets.reduce((sum, t) => sum + t.assignments.reduce((s, a) => s + (a.violations?.length ?? 0), 0), 0)
    console.log(`| ${c.name} | ${tickets.length} | ${done} | ${Math.round((firstTry / tickets.length) * 100)}% | ${revisions} | ${violations} | ${traces.spans.length} |`)
    if (done !== tickets.length) failed = true
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (failed) process.exit(1)

