/**
 * The orchestrator runs a plan: it starts each ticket once its inputs passed their contracts, gives its worker a tool slot
 * and its locks, gates the result through the asset contract, sends violations back as a revision, ingests what passed,
 * and holds assets for a person's review where the plan asks for it.
 *
 * It is the deterministic half of the Router layer: an LLM wrote the plan, but who runs when, with which locks, and
 * whether a hand-off is accepted are decided here, in code. Every change is stored before the next step, so a restarted
 * host continues the same run (see `recover`).
 */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { checkDelivery } from '../contracts/index.ts'
import type { LockManager } from '../locks/index.ts'
import { INGESTED, type AssetRecord, type AssignmentRecord, type Domain, type Plan, type PlanRun, type RunEvent, type TicketRun, type TicketSpec, type TicketState, type Violation, type WorkerResult } from './model.ts'
import { dependencies, topologicalOrder } from './plan.ts'
import type { Pools } from './pools.ts'
import type { Executor, Ingestor } from './ports.ts'
import type { StoreLike } from './store.ts'
import { BudgetTracker, type TraceCollector } from './telemetry.ts'

export interface OrchestratorOptions {
  plan: Plan
  store: StoreLike
  executor: Executor
  ingestor?: Ingestor
  pools: Pools
  locks: LockManager
  /** The pool a domain's workers occupy, from its preset. */
  poolOf: (domain: Domain) => string
  onEvent?: (event: RunEvent) => void
  now?: () => Date
  /** The Godot project folder, where res:// paths resolve, for Godot plans. */
  projectDir?: string
  /** Optional OpenTelemetry-compatible span collector for tracing tickets and contract gates. */
  telemetry?: TraceCollector
}

/** States in which a ticket waits for a person; `answer` releases them. */
export const PERSON_STATES: readonly TicketState[] = ['attention', 'blocked', 'failed', 'review']
const ACTIVE_STATES: readonly TicketState[] = ['running', 'validating', 'revising']
const MAX_EVENTS = 1000

export class Orchestrator {
  readonly run: PlanRun
  readonly budget: BudgetTracker
  private readonly options: OrchestratorOptions
  private specs: Map<string, TicketSpec>
  private deps: Map<string, Set<string>>
  private order: string[]
  private readonly working = new Map<string, Promise<void>>()
  private readonly controllers = new Map<string, AbortController>()
  /** The last reason a queued ticket could not start, so the same lock wait is logged once, not on every pass. */
  private readonly waitReason = new Map<string, string>()

  constructor(options: OrchestratorOptions) {
    this.options = options
    this.specs = new Map(options.plan.tickets.map(ticket => [ticket.id, ticket]))
    this.deps = dependencies(options.plan)
    this.order = topologicalOrder(options.plan)
    const stored = options.store.load()
    if (stored && JSON.stringify(stored.plan) !== JSON.stringify(options.plan))
      throw new Error(`${options.store.path} holds a run of a different plan (${stored.planId}); use a new state directory or --fresh`)
    this.run = stored ?? this.fresh()
    this.budget = new BudgetTracker(options.plan.budget, Date.parse(this.run.startedAt) || Date.now())
    if (stored) this.recover()
    this.save()
  }

  /**
   * Incremental re-planning: updates the plan in place, keeping delivered assets for every ticket whose
   * spec and upstream dependencies did not change, and re-queuing only changed tickets and their consumers.
   */
  replan(nextPlan: Plan): { kept: string[]; invalidated: string[]; added: string[]; removed: string[] } {
    if (this.working.size) throw new Error('cannot replan while workers are running; call stop() first')
    const specHash = (spec: TicketSpec) => createHash('sha256').update(JSON.stringify(spec)).digest('hex')
    const prevSpecs = this.specs
    const nextSpecs = new Map(nextPlan.tickets.map(t => [t.id, t]))
    const nextDeps = dependencies(nextPlan)
    const nextOrder = topologicalOrder(nextPlan)
    const invalidated = new Set<string>()
    const added: string[] = []
    const removed: string[] = []
    const kept: string[] = []

    for (const oldId of prevSpecs.keys()) {
      if (!nextSpecs.has(oldId)) {
        this.options.locks.releaseAll(oldId)
        delete this.run.tickets[oldId]
        removed.push(oldId)
      }
    }

    for (const id of nextOrder) {
      const nextSpec = nextSpecs.get(id)!
      const prevSpec = prevSpecs.get(id)
      const depInvalidated = [...nextDeps.get(id)!].some(dep => invalidated.has(dep) || added.includes(dep))
      if (!prevSpec) {
        this.run.tickets[id] = { id, state: 'waiting', assignments: [], delivered: {}, notes: [], updatedAt: this.now }
        added.push(id)
      } else if (specHash(prevSpec) !== specHash(nextSpec) || depInvalidated) {
        const ticket = this.run.tickets[id]!
        ticket.delivered = {}
        ticket.attention = undefined
        ticket.state = 'waiting'
        ticket.updatedAt = this.now
        ticket.notes.push(depInvalidated ? 'Replan: an upstream dependency changed; rebuild with updated inputs.' : 'Replan: ticket spec changed.')
        invalidated.add(id)
      } else {
        kept.push(id)
      }
    }

    this.options.plan = nextPlan
    this.run.plan = nextPlan
    this.specs = nextSpecs
    this.deps = nextDeps
    this.order = nextOrder
    this.log(undefined, 'plan.replanned', `kept=${kept.length} invalidated=${invalidated.size} added=${added.length} removed=${removed.length}`)
    return { kept, invalidated: [...invalidated], added, removed }
  }

  private get now(): string { return (this.options.now?.() ?? new Date()).toISOString() }

  /** Runs until nothing more can start without a person or an outside lock holder. */
  async runUntilIdle(): Promise<PlanRun> {
    this.schedule()
    while (this.working.size) {
      await Promise.race(this.working.values())
      this.schedule()
    }
    return this.run
  }

  /** Stops every running worker; their tickets resume with a recovery note on the next run. */
  stop(): void {
    for (const controller of this.controllers.values()) controller.abort()
  }

  /** A person approves the assets a `review` ticket delivered; its consumers may start. */
  approve(ticketId: string, note?: string): void {
    const ticket = this.ticket(ticketId)
    if (ticket.state !== 'review') throw new Error(`${ticketId} is ${ticket.state}, not awaiting review`)
    if (note) ticket.notes.push(`Approved: ${note}`)
    this.complete(ticketId, 'approved by a person')
  }

  /**
   * A person answers a ticket that waits for them: the answer to its question, what to change in a review, or nothing
   * to just retry. The ticket queues for a new assignment that receives the answer.
   */
  answer(ticketId: string, text?: string): void {
    const ticket = this.ticket(ticketId)
    if (!PERSON_STATES.includes(ticket.state)) throw new Error(`${ticketId} is ${ticket.state}; it is not waiting for a person`)
    if (text) ticket.notes.push(ticket.state === 'review' ? `Review asked for changes: ${text}` : `Answer: ${text}`)
    if (ticket.state === 'review') {
      for (const id of Object.keys(ticket.delivered)) delete ticket.delivered[id]
    }
    ticket.attention = undefined
    this.setState(ticketId, 'queued', text ? 'a person answered' : 'a person asked for a retry')
  }

  // ---- scheduling ---------------------------------------------------------------------------------------------------

  private schedule(): void {
    const budgetExceeded = this.budget.exceeded((this.options.now?.() ?? new Date()).getTime())
    if (budgetExceeded) {
      for (const id of this.order) {
        const ticket = this.ticket(id)
        if (ticket.state === 'queued' || (ticket.state === 'waiting' && [...this.deps.get(id)!].every(dep => this.ticket(dep).state === 'done'))) {
          ticket.attention = budgetExceeded
          this.setState(id, 'attention', budgetExceeded)
        }
      }
      return
    }
    for (const id of this.order) {
      const ticket = this.ticket(id)
      if (ticket.state === 'waiting' && [...this.deps.get(id)!].every(dep => this.ticket(dep).state === 'done'))
        this.setState(id, 'queued', 'its inputs are ready')
      if (ticket.state !== 'queued' || this.working.has(id)) continue
      const spec = this.specs.get(id)!
      const pool = this.options.poolOf(spec.domain)
      if (!this.options.pools.tryAcquire(pool)) {
        this.waiting(id, `waiting for a ${pool} slot`)
        continue
      }
      const locked = this.options.locks.acquireAll(id, spec.locks)
      if (!locked.ok) {
        this.options.pools.release(pool)
        this.waiting(id, `waiting for ${locked.path}, locked by ${locked.holder}`)
        continue
      }
      this.waitReason.delete(id)
      if (spec.locks.length) this.log(id, 'locks.acquired', spec.locks.join(', '))
      this.run.locks = this.options.locks.held()
      const work = this.work(spec, pool).catch(error => {
        this.ticket(id).attention = `host error: ${(error as Error).message}`
        this.setState(id, 'failed', (error as Error).message)
      }).finally(() => {
        this.working.delete(id)
        this.controllers.delete(id)
      })
      this.working.set(id, work)
    }
  }

  private waiting(id: string, reason: string): void {
    if (this.waitReason.get(id) === reason) return
    this.waitReason.set(id, reason)
    this.log(id, 'ticket.waiting', reason)
  }

  /** One ticket's assignments: run, gate, revise until the contract passes or the revisions run out. The pool slot is held on entry. */
  private async work(spec: TicketSpec, pool: string): Promise<void> {
    const ticket = this.ticket(spec.id)
    const first = ticket.assignments.length
    let feedback: Violation[] = []
    for (let round = 0; ; round++) {
      if (round > 0) await this.options.pools.acquire(pool)
      const controller = new AbortController()
      this.controllers.set(spec.id, controller)
      const assignment: AssignmentRecord = { id: `${spec.id}-a${first + round + 1}`, revision: first + round, startedAt: this.now }
      ticket.assignments.push(assignment)
      this.setState(spec.id, round ? 'revising' : 'running', round ? `revision ${round} with ${feedback.length} contract violation(s)` : `assignment ${assignment.id}`)
      const span = this.options.telemetry?.startSpan('harness.assignment', { planId: this.run.planId, ticketId: spec.id, domain: spec.domain, revision: assignment.revision })
      let result: WorkerResult
      try {
        result = await this.options.executor.run({
          plan: this.options.plan, ticket: spec, assignmentId: assignment.id, revision: assignment.revision,
          dir: this.options.store.ticketDir(spec.id), inputs: this.inputsOf(spec), feedback, notes: [...ticket.notes], projectDir: this.options.projectDir,
          signal: controller.signal,
        })
      } catch (error) {
        result = { status: 'failed', summary: `the worker did not finish: ${(error as Error).message}`, assets: [] }
      } finally {
        this.options.pools.release(pool)
      }
      if (controller.signal.aborted) { span?.end('ERROR', { aborted: true }); return } // stopped by the host; recover() requeues it on the next run
      this.budget.record(result.usage)
      span?.end(result.status === 'ready' ? 'OK' : 'ERROR', {
        status: result.status,
        ...(result.usage?.inputTokens !== undefined ? { inputTokens: result.usage.inputTokens } : {}),
        ...(result.usage?.outputTokens !== undefined ? { outputTokens: result.usage.outputTokens } : {}),
        ...(result.usage?.costUsd !== undefined ? { costUsd: result.usage.costUsd } : {}),
      })
      Object.assign(assignment, { endedAt: this.now, result })
      this.log(spec.id, `report.${result.status}`, result.summary)

      if (result.question) {
        ticket.attention = result.question
        return this.setState(spec.id, 'attention', 'the worker asked a question')
      }
      switch (result.status) {
        case 'ready': break
        case 'dropped': {
          this.options.locks.releaseAll(spec.id)
          this.run.locks = this.options.locks.held()
          return this.setState(spec.id, 'dropped', result.summary)
        }
        case 'progress':
          ticket.attention = `The worker ended its turn without finishing: ${result.summary}`
          return this.setState(spec.id, 'attention', 'unfinished turn')
        default:
          ticket.attention = result.summary
          return this.setState(spec.id, result.status, result.summary)
      }

      this.setState(spec.id, 'validating', `${result.assets.length} asset(s)`)
      const { violations, assets } = await this.gate(spec, result)
      assignment.violations = violations
      if (!violations.length) {
        for (const asset of assets) ticket.delivered[asset.id] = asset
        if (spec.review === 'human') {
          ticket.attention = `Review ${assets.map(asset => asset.id).join(', ')} and approve, or answer with the changes you want`
          return this.setState(spec.id, 'review', 'contract passed; awaiting a person\'s review')
        }
        return this.complete(spec.id, 'contract passed')
      }
      for (const violation of violations) this.log(spec.id, 'contract.violation', `${violation.rule}: ${violation.message}`)
      if (round >= spec.maxRevisions) {
        ticket.attention = `The contract still fails after ${round} revision(s):\n${violations.map(v => `- ${v.message}`).join('\n')}`
        return this.setState(spec.id, 'attention', 'revisions exhausted')
      }
      feedback = violations
    }
  }

  /** The contract, then engine ingest for the kinds that live in the engine. */
  private async gate(spec: TicketSpec, result: WorkerResult): Promise<{ violations: Violation[]; assets: AssetRecord[] }> {
    const dir = this.options.store.ticketDir(spec.id)
    const checked = checkDelivery(spec, result, { dir, projectDir: this.options.projectDir })
    if (checked.violations.length || !this.options.ingestor) return checked
    const ingestor = this.options.ingestor
    const assets: AssetRecord[] = []
    const violations: Violation[] = []
    for (const asset of checked.assets) {
      const assetSpec = spec.produces.find(item => item.id === asset.id)!
      if (!INGESTED.includes(asset.kind)) {
        assets.push(asset)
        continue
      }
      await this.options.pools.acquire(ingestor.pool)
      try {
        const ingested = await ingestor.ingest({ plan: this.options.plan, ticket: spec, spec: assetSpec, asset, dir })
        violations.push(...ingested.violations)
        assets.push({ ...asset, engine: { objectPath: ingested.objectPath, facts: ingested.facts } })
        this.log(spec.id, 'asset.ingested', `${asset.id} → ${ingested.objectPath}`)
      } catch (error) {
        violations.push({ asset: asset.id, rule: 'ingest.error', message: `ingest of ${asset.id} failed: ${(error as Error).message}` })
      } finally {
        this.options.pools.release(ingestor.pool)
      }
    }
    return { violations, assets }
  }

  private complete(id: string, reason: string): void {
    const ticket = this.ticket(id)
    ticket.attention = undefined
    this.options.locks.releaseAll(id)
    this.run.locks = this.options.locks.held()
    this.setState(id, 'done', reason)
  }

  /** The assets a ticket consumes, as their producers delivered them, with paths a worker in another directory can open. */
  private inputsOf(spec: TicketSpec): AssetRecord[] {
    return spec.consumes.map(assetId => {
      const producer = this.options.plan.tickets.find(ticket => ticket.produces.some(item => item.id === assetId))!
      const record = this.ticket(producer.id).delivered[assetId]
      if (!record) throw new Error(`${spec.id} started before ${assetId} was delivered`)
      const dir = this.options.store.ticketDir(producer.id)
      return { ...record, files: record.files.map(file => file.role === 'engine' || file.path.startsWith('res://') ? file : { ...file, path: resolve(dir, file.path) }) }
    })
  }

  // ---- state ----------------------------------------------------------------------------------------------------------

  private fresh(): PlanRun {
    const at = this.now
    const tickets: Record<string, TicketRun> = {}
    for (const ticket of this.options.plan.tickets)
      tickets[ticket.id] = { id: ticket.id, state: 'waiting', assignments: [], delivered: {}, notes: [], updatedAt: at }
    return { planId: this.options.plan.id, plan: this.options.plan, tickets, locks: [], events: [], startedAt: at, updatedAt: at }
  }

  /** After a restart: work that was running starts again, told to check what it already did before repeating outside actions. */
  private recover(): void {
    this.options.locks.restore(this.run.locks)
    for (const ticket of Object.values(this.run.tickets)) {
      if (!ACTIVE_STATES.includes(ticket.state)) continue
      const last = ticket.assignments.at(-1)
      if (last && !last.endedAt) Object.assign(last, { endedAt: this.now, result: { status: 'failed', summary: 'host restarted', assets: [] } })
      ticket.notes.push(`Recovery: the host restarted while ${last?.id ?? 'this ticket'} ran. Check your directory and the DCC's state before repeating any outside action, such as a WAAPI import, an engine save or a p4 edit.`)
      this.setState(ticket.id, 'queued', 'host restarted')
    }
  }

  private ticket(id: string): TicketRun {
    const ticket = this.run.tickets[id]
    if (!ticket) throw new Error(`unknown ticket ${id}`)
    return ticket
  }

  private setState(id: string, state: TicketState, detail: string): void {
    const ticket = this.ticket(id)
    ticket.state = state
    ticket.updatedAt = this.now
    this.log(id, `ticket.${state}`, detail)
  }

  private log(ticketId: string | undefined, type: string, detail: string): void {
    const event: RunEvent = { at: this.now, ticketId, type, detail }
    this.run.events.push(event)
    if (this.run.events.length > MAX_EVENTS) this.run.events.splice(0, this.run.events.length - MAX_EVENTS)
    this.run.updatedAt = event.at
    this.options.store.appendEvent?.(event)
    this.save()
    this.options.onEvent?.(event)
  }

  private save(): void {
    this.options.store.save(this.run)
  }
}
