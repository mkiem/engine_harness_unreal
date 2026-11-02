/**
 * Plan checks and graph queries. A plan is a DAG whose edges are assets: ticket B depends on ticket A exactly when B
 * consumes an asset A produces (plus any explicit `after`). Checking it before anything runs turns an LLM planner's
 * structural mistakes into a precise error instead of a stalled pipeline.
 */
import { prefixProblem } from '../contracts/naming.ts'
import { Plan, PRODUCES, type AssetSpec, type TicketSpec } from './model.ts'

export class PlanError extends Error {
  readonly problems: string[]
  constructor(problems: string[]) {
    super(`invalid plan:\n- ${problems.join('\n- ')}`)
    this.problems = problems
  }
}

/** Parses and checks a plan; throws PlanError listing every problem at once, so a planner can fix them in one revision. */
export function parsePlan(input: unknown): Plan {
  const parsed = Plan.safeParse(input)
  if (!parsed.success)
    throw new PlanError(parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`))
  const problems = planProblems(parsed.data)
  if (problems.length) throw new PlanError(problems)
  return parsed.data
}

export function planProblems(plan: Plan): string[] {
  const problems: string[] = []
  const tickets = new Map<string, TicketSpec>()
  for (const ticket of plan.tickets) {
    if (tickets.has(ticket.id)) problems.push(`ticket ${ticket.id} appears twice`)
    tickets.set(ticket.id, ticket)
  }
  const producer = new Map<string, string>()
  for (const ticket of plan.tickets) {
    for (const spec of ticket.produces) {
      const other = producer.get(spec.id)
      if (other) problems.push(`asset ${spec.id} is produced by both ${other} and ${ticket.id}`)
      producer.set(spec.id, ticket.id)
      if (!PRODUCES[ticket.domain].includes(spec.kind))
        problems.push(`${ticket.id} (${ticket.domain}) cannot produce ${spec.kind} ${spec.id}; ${ticket.domain} produces ${PRODUCES[ticket.domain].join(', ')}`)
      const prefix = prefixProblem(spec.kind, spec.id)
      if (prefix) problems.push(`${ticket.id}: ${prefix}`)
    }
  }
  for (const ticket of plan.tickets) {
    for (const id of ticket.consumes) {
      const from = producer.get(id)
      if (!from) problems.push(`${ticket.id} consumes ${id}, which no ticket produces`)
      else if (from === ticket.id) problems.push(`${ticket.id} consumes its own asset ${id}`)
    }
    for (const id of ticket.after) if (!tickets.has(id)) problems.push(`${ticket.id} runs after unknown ticket ${id}`)
    for (const spec of ticket.produces) problems.push(...crossReferenceProblems(ticket, spec, producer))
  }
  const cycle = findCycle(plan)
  if (cycle) problems.push(`dependency cycle: ${cycle.join(' → ')}`)
  return problems
}

/** Specs that name other assets must also consume them, so the edge (and its contract gate) exists in the graph. */
function crossReferenceProblems(ticket: TicketSpec, spec: AssetSpec, producer: Map<string, string>): string[] {
  const named: string[] = []
  if (spec.kind === 'audio_event') named.push(spec.requires.clip)
  if (spec.kind === 'level_placement') named.push(spec.requires.actorClass)
  return named.flatMap(id => {
    const owner = producer.get(id)
    if (!owner) return [`${spec.id} names ${id}, which no ticket produces`]
    if (owner !== ticket.id && !ticket.consumes.includes(id)) return [`${ticket.id} must list ${id} in consumes, because ${spec.id} uses it`]
    return []
  })
}

/** Ticket ids each ticket waits for, from its consumed assets and its explicit `after`. */
export function dependencies(plan: Plan): Map<string, Set<string>> {
  const producer = new Map(plan.tickets.flatMap(ticket => ticket.produces.map(spec => [spec.id, ticket.id] as const)))
  return new Map(plan.tickets.map(ticket => [ticket.id, new Set([
    ...ticket.consumes.map(id => producer.get(id)).filter((id): id is string => !!id && id !== ticket.id),
    ...ticket.after,
  ])]))
}

function findCycle(plan: Plan): string[] | undefined {
  const deps = dependencies(plan)
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === 'done') return undefined
    if (state.get(id) === 'visiting') return [...stack.slice(stack.indexOf(id)), id]
    state.set(id, 'visiting')
    stack.push(id)
    for (const dep of deps.get(id) ?? []) {
      const found = visit(dep)
      if (found) return found
    }
    stack.pop()
    state.set(id, 'done')
    return undefined
  }
  for (const ticket of plan.tickets) {
    const found = visit(ticket.id)
    if (found) return found
  }
  return undefined
}

/** Tickets in an order where each comes after everything it depends on; ties keep plan order. */
export function topologicalOrder(plan: Plan): string[] {
  const deps = dependencies(plan)
  const done = new Set<string>()
  const order: string[] = []
  while (order.length < plan.tickets.length) {
    const next = plan.tickets.find(ticket => !done.has(ticket.id) && [...deps.get(ticket.id)!].every(dep => done.has(dep)))
    if (!next) throw new PlanError(['dependency cycle'])
    done.add(next.id)
    order.push(next.id)
  }
  return order
}

/** Groups tickets into waves that can run in parallel, for display: wave n depends only on waves before it. */
export function waves(plan: Plan): string[][] {
  const deps = dependencies(plan)
  const level = new Map<string, number>()
  for (const id of topologicalOrder(plan)) level.set(id, Math.max(-1, ...[...deps.get(id)!].map(dep => level.get(dep)!)) + 1)
  const result: string[][] = []
  for (const [id, n] of level) (result[n] ??= []).push(id)
  return result
}
