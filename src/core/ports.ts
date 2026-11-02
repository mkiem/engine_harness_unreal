/** Ports the orchestrator depends on. Executors and ingestors are deployment-specific; the core never talks to a DCC. */
import type { AssetRecord, AssetSpec, Plan, TicketSpec, Violation, WorkerResult } from './model.ts'

/** One run of one ticket's worker: dsh-superagent's Assignment plus the inputs and feedback a pipeline ticket needs. */
export interface Job {
  plan: Plan
  ticket: TicketSpec
  assignmentId: string
  /** 0 for the first run; a contract failure sent back to the worker makes revision 1, 2, ... */
  revision: number
  /** The ticket's own directory; the worker writes everything here and reports paths relative to it. */
  dir: string
  /** The consumed assets, as they passed their contracts, with file paths made absolute. */
  inputs: AssetRecord[]
  /** What the contract rejected in the previous revision; empty on revision 0. */
  feedback: Violation[]
  /** Answers and approvals from people, and recovery notes after a restart. */
  notes: string[]
  signal: AbortSignal
}

export interface Executor {
  run(job: Job): Promise<WorkerResult>
}

export interface IngestRequest {
  plan: Plan
  ticket: TicketSpec
  spec: AssetSpec
  asset: AssetRecord
  dir: string
}

export interface IngestResult {
  objectPath: string
  facts: Record<string, unknown>
  violations: Violation[]
}

/** Imports an asset that passed its source contract into the engine with fixed settings, and checks it there. */
export interface Ingestor {
  /** The tool pool ingest occupies, normally the one the Unreal workers use, since both need the project. */
  readonly pool: string
  ingest(request: IngestRequest): Promise<IngestResult>
}
