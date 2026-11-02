import { describe, expect, it } from 'vitest'
import type { Plan, WorkerResult } from '../src/core/model.ts'
import { Orchestrator } from '../src/core/orchestrator.ts'
import { Pools } from '../src/core/pools.ts'
import type { Executor, Job } from '../src/core/ports.ts'
import { RunStore } from '../src/core/store.ts'
import { SimulatedExecutor } from '../src/executors/simulated.ts'
import { SimulatedIngestor } from '../src/ingest/index.ts'
import { LockManager, MemoryLockBackend } from '../src/locks/index.ts'
import { propPlan } from '../src/planner/index.ts'
import { radioPlan, tempDir } from './fixtures.ts'

function orchestrator(plan: Plan, executor: Executor, options: { dir?: string; locks?: LockManager; pools?: Pools } = {}) {
  const dir = options.dir ?? tempDir()
  return new Orchestrator({
    plan, store: new RunStore(dir), executor, ingestor: new SimulatedIngestor(), pools: options.pools ?? new Pools({ blender: 2 }),
    locks: options.locks ?? new LockManager(new MemoryLockBackend()), poolOf: domain => (domain === 'qa' ? 'unreal' : domain),
  })
}

/** Records the order and overlap of assignments around a delegate executor. */
class Recording implements Executor {
  readonly started: string[] = []
  readonly jobs: Job[] = []
  maxParallel = 0
  private running = 0
  private readonly inner: Executor
  constructor(inner: Executor) {
    this.inner = inner
  }
  async run(job: Job): Promise<WorkerResult> {
    this.started.push(job.assignmentId)
    this.jobs.push(job)
    this.maxParallel = Math.max(this.maxParallel, ++this.running)
    try {
      return await this.inner.run(job)
    } finally {
      this.running--
    }
  }
}

const states = (o: Orchestrator) => Object.fromEntries(Object.values(o.run.tickets).map(t => [t.id, t.state]))

describe('Orchestrator', () => {
  it('runs a prop plan end to end, in dependency order, with independent tickets in parallel', async () => {
    const executor = new Recording(new SimulatedExecutor({ delayMs: 20 }))
    const o = orchestrator(radioPlan(), executor)
    const run = await o.runUntilIdle()
    expect(Object.values(run.tickets).every(t => t.state === 'done')).toBe(true)
    expect(executor.started.slice(0, 2).sort()).toEqual(['vintage-radio-audio-a1', 'vintage-radio-model-a1'])
    expect(executor.maxParallel).toBe(2)
    expect(executor.started.at(-1)).toBe('vintage-radio-qa-a1')
    expect(run.locks).toEqual([])
    expect(run.tickets['vintage-radio-model']!.delivered.SM_VintageRadio!.engine?.objectPath).toBe('/Game/Props/VintageRadio/SM_VintageRadio')
  })

  it('sends contract violations back to the worker and passes on the revision', async () => {
    const executor = new Recording(new SimulatedExecutor({ faults: true }))
    const run = await orchestrator(radioPlan(), executor).runUntilIdle()
    expect(Object.values(run.tickets).every(t => t.state === 'done')).toBe(true)
    const model = executor.jobs.filter(job => job.ticket.id === 'vintage-radio-model')
    expect(model.map(job => job.revision)).toEqual([0, 1])
    expect(model[1]!.feedback.map(v => v.rule)).toEqual(['collision.target', 'mesh.size', 'mesh.size', 'mesh.size'])
  })

  it('gives consumers their inputs with absolute paths', async () => {
    const executor = new Recording(new SimulatedExecutor())
    await orchestrator(radioPlan(), executor).runUntilIdle()
    const texture = executor.jobs.find(job => job.ticket.id === 'vintage-radio-texture')!
    expect(texture.inputs.map(input => input.id)).toEqual(['SM_VintageRadio'])
    expect(texture.inputs[0]!.files[0]!.path).toMatch(/work\/vintage-radio-model\/export\/SM_VintageRadio\.fbx$/)
  })

  it('asks a person after the revisions run out, and retries on their answer', async () => {
    let fixed = false
    const sim = new SimulatedExecutor({ faults: true })
    const stubborn: Executor = { run: job => sim.run({ ...job, revision: fixed ? 1 : 0 }) }
    const plan = radioPlan()
    plan.tickets.find(t => t.id === 'vintage-radio-model')!.maxRevisions = 1
    const dir = tempDir()
    const o = orchestrator(plan, stubborn, { dir })
    await o.runUntilIdle()
    expect(states(o)['vintage-radio-model']).toBe('attention')
    expect(o.run.tickets['vintage-radio-model']!.attention).toContain('still fails after 1 revision')
    expect(states(o)['vintage-radio-texture']).toBe('waiting')
    // Both stubborn tickets keep their locks while they wait for a person, so nobody else edits a half-fixed file.
    expect(o.run.locks.map(l => l.path)).toEqual(['ArtSource/Props/VintageRadio/SM_VintageRadio.blend', 'Wwise/Events/Play_RadioStatic.wwu'])

    fixed = true
    o.answer('vintage-radio-model', 'Name the hull after SM_VintageRadio and export at unit scale 1.0')
    o.answer('vintage-radio-audio')
    await o.runUntilIdle()
    expect(Object.values(o.run.tickets).every(t => t.state === 'done')).toBe(true)
    expect(o.run.tickets['vintage-radio-model']!.notes).toContain('Answer: Name the hull after SM_VintageRadio and export at unit scale 1.0')
  })

  it('holds human-review assets until a person approves them', async () => {
    const plan = propPlan({ name: 'Crate', description: 'a crate', sizeCm: [60, 60, 60], maxTriangles: 2000, lods: 1, textureResolution: 1024, artReview: true })
    const o = orchestrator(plan, new SimulatedExecutor())
    await o.runUntilIdle()
    expect(states(o)).toMatchObject({ 'crate-model': 'review', 'crate-texture': 'waiting', 'crate-blueprint': 'waiting' })
    o.approve('crate-model', 'silhouette reads well')
    await o.runUntilIdle()
    expect(states(o)).toMatchObject({ 'crate-model': 'done', 'crate-texture': 'review' })
    o.approve('crate-texture')
    await o.runUntilIdle()
    expect(Object.values(o.run.tickets).every(t => t.state === 'done')).toBe(true)
  })

  it('waits while a person holds a lock outside the harness', async () => {
    const backend = new MemoryLockBackend()
    backend.acquire('Wwise/Events/Play_RadioStatic.wwu', 'sound-designer')
    const o = orchestrator(radioPlan(), new SimulatedExecutor(), { locks: new LockManager(backend) })
    await o.runUntilIdle()
    expect(states(o)['vintage-radio-audio']).toBe('queued')
    expect(o.run.events.some(e => e.detail.includes('locked by sound-designer'))).toBe(true)
    backend.release('Wwise/Events/Play_RadioStatic.wwu', 'sound-designer')
    await o.runUntilIdle()
    expect(Object.values(o.run.tickets).every(t => t.state === 'done')).toBe(true)
  })

  it('respects tool pools: one Unreal slot serialises engine work', async () => {
    const executor = new Recording(new SimulatedExecutor({ delayMs: 10 }))
    await orchestrator(radioPlan(), executor, { pools: new Pools({ blender: 1, audio: 1 }) }).runUntilIdle()
    expect(executor.maxParallel).toBe(2)
  })

  it('resumes after a restart with a recovery note', async () => {
    const dir = tempDir()
    let release: () => void = () => {}
    const hanging: Executor = { run: job => new Promise((_, reject) => { release = () => reject(new Error('killed')); job.signal.addEventListener('abort', () => reject(new Error('aborted'))) }) }
    const first = orchestrator(radioPlan(), hanging, { dir })
    const running = first.runUntilIdle()
    await new Promise(resolve => setTimeout(resolve, 20))
    first.stop()
    await running
    release()
    expect(states(first)['vintage-radio-model']).toBe('running') // stored as it was when the host went away

    const executor = new Recording(new SimulatedExecutor())
    const second = orchestrator(radioPlan(), executor, { dir })
    await second.runUntilIdle()
    expect(Object.values(second.run.tickets).every(t => t.state === 'done')).toBe(true)
    expect(executor.jobs.find(job => job.ticket.id === 'vintage-radio-model')!.notes[0]).toMatch(/^Recovery: the host restarted/)
  })

  it('refuses a stored run of a different plan', () => {
    const dir = tempDir()
    orchestrator(radioPlan(), new SimulatedExecutor(), { dir })
    const other = propPlan({ name: 'Crate', description: 'a crate', sizeCm: [60, 60, 60], maxTriangles: 2000, lods: 1, textureResolution: 1024, artReview: false })
    expect(() => orchestrator(other, new SimulatedExecutor(), { dir })).toThrow(/different plan/)
  })

  it('treats a question as attention and a crash as failure', async () => {
    const asking: Executor = { run: async job => job.ticket.domain === 'audio' ? { status: 'blocked', summary: 'no licence', question: 'May I use library clip LIB-123?', assets: [] } : new SimulatedExecutor().run(job) }
    const o = orchestrator(radioPlan(), asking)
    await o.runUntilIdle()
    expect(states(o)['vintage-radio-audio']).toBe('attention')
    expect(o.run.tickets['vintage-radio-audio']!.attention).toBe('May I use library clip LIB-123?')
    expect(states(o)['vintage-radio-blueprint']).toBe('waiting')
  })
})
