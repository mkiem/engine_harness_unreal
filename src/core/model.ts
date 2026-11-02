/**
 * Domain model of the studio harness. Every value that crosses a boundary (a plan an LLM wrote, a worker's result, a
 * preset on disk) is parsed with these schemas, so the rest of the code works with checked data only.
 *
 * Vocabulary follows dsh-superagent where the concept is the same (Ticket, Assignment, Report, Attention) and adds the
 * concepts a multi-DCC pipeline needs: Domain, AssetSpec (what a ticket promises), AssetRecord (what it delivered), and
 * Plan (tickets wired together by the assets they produce and consume).
 */
import { z } from 'zod'

/**
 * The worker specialities. Each maps to one preset, which gives the worker only the tools of that domain. Engine ingest is
 * not a domain: importing an asset that passed its contract is a deterministic pipeline stage (`src/ingest`), not an agent.
 */
export const Domain = z.enum(['blender', 'texture', 'audio', 'unreal', 'qa'])
export type Domain = z.infer<typeof Domain>

/** The kinds of asset that cross a ticket boundary. Each has its own contract (`src/contracts`). */
export const AssetKind = z.enum(['static_mesh', 'skeletal_mesh', 'texture_set', 'audio_clip', 'audio_event', 'blueprint', 'level_placement', 'test_result'])
export type AssetKind = z.infer<typeof AssetKind>

/** Which domain may produce which kinds; a plan that asks a domain for another kind is rejected before it runs. */
export const PRODUCES: Record<Domain, readonly AssetKind[]> = {
  blender: ['static_mesh', 'skeletal_mesh'],
  texture: ['texture_set'],
  audio: ['audio_clip', 'audio_event'],
  unreal: ['blueprint', 'level_placement'],
  qa: ['test_result'],
}
/** Kinds the ingest stage imports into the engine after their contract passed, before any consumer may use them. */
export const INGESTED: readonly AssetKind[] = ['static_mesh', 'skeletal_mesh', 'texture_set', 'audio_event']

/** Asset ids are Unreal object names, so one id names the asset in every tool: SM_VintageRadio, T_VintageRadio, Play_Radio_Static. */
export const AssetId = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{1,62}$/, 'asset id must be an Unreal-safe identifier')

// ---- Specs: what a ticket promises to deliver ---------------------------------------------------------------------------

const StaticMeshRequirements = z.object({
  /** Upper bound on LOD0 triangles; the contract rejects a mesh over it. */
  maxTriangles: z.number().int().positive(),
  /** Number of LODs including LOD0. 1 means the engine generates none. */
  lods: z.number().int().min(1).max(8).default(1),
  /** `ucx` requires hand-authored convex hulls named UCX_<mesh>_NN; `engine` lets the importer generate one; `none` for decals. */
  collision: z.enum(['ucx', 'engine', 'none']).default('ucx'),
  /** `base` puts the pivot at the bottom centre of the bounds, as props are placed on floors; `origin` keeps it at 0,0,0. */
  pivot: z.enum(['base', 'origin']).default('base'),
  /** Expected size in centimetres, [x, y, z]; the contract allows `sizeTolerance` relative error to catch unit mistakes (x100). */
  approxSizeCm: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]).optional(),
  sizeTolerance: z.number().positive().default(0.5),
  /** Material slots the mesh must expose, in order; ingest assigns master material instances to them by name. */
  materialSlots: z.array(z.string()).default([]),
  lightmapUv: z.boolean().default(true),
}).strict()

const TextureSetRequirements = z.object({
  resolution: z.number().int().refine(n => n >= 64 && n <= 8192 && (n & (n - 1)) === 0, 'resolution must be a power of two'),
  /** Channel-packed ORM (R occlusion, G roughness, B metallic) is the default the master material expects. */
  maps: z.array(z.enum(['BaseColor', 'Normal', 'ORM', 'Emissive', 'Opacity'])).default(['BaseColor', 'Normal', 'ORM']),
  /** Normal maps for Unreal are DirectX (Y-) convention. */
  normalConvention: z.enum(['directx', 'opengl']).default('directx'),
}).strict()

const AudioClipRequirements = z.object({
  sampleRate: z.number().int().default(48000),
  channels: z.number().int().min(1).max(8).default(1),
  bitDepth: z.number().int().default(16),
  minSeconds: z.number().positive().default(0.1),
  maxSeconds: z.number().positive().default(30),
  /** Peak ceiling in dBFS; anything above clips after the engine's mix. */
  maxPeakDb: z.number().max(0).default(-1),
  /** Integrated loudness window, approximated by RMS dBFS when no LUFS meter ran. */
  loudnessDb: z.tuple([z.number(), z.number()]).default([-30, -12]),
  loop: z.boolean().default(false),
}).strict()

const AudioEventRequirements = z.object({
  /** The clip the event plays. */
  clip: AssetId,
  /** Wwise attenuation ShareSet name; required for 3D sounds. */
  attenuation: z.string().optional(),
  maxDistanceCm: z.number().positive().optional(),
  bus: z.string().default('Master Audio Bus'),
}).strict()

const BlueprintRequirements = z.object({
  parentClass: z.string().default('Actor'),
  /** Components the Blueprint must have, by class, such as StaticMeshComponent and AkComponent. */
  components: z.array(z.string()).default([]),
  /** Interfaces it must implement, such as BPI_Interactable. */
  interfaces: z.array(z.string()).default([]),
}).strict()

const LevelPlacementRequirements = z.object({
  map: z.string().regex(/^\/Game\//, 'map must be a /Game/ path'),
  actorClass: AssetId,
  location: z.tuple([z.number(), z.number(), z.number()]),
  rotation: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  /** World Partition maps store each actor in its own file (One File Per Actor); the lock covers that file, not the map. */
  oneFilePerActor: z.boolean().default(true),
}).strict()

const TestResultRequirements = z.object({
  /** Automation test names to run, such as Project.Props.VintageRadio.Interact. */
  tests: z.array(z.string()).min(1),
}).strict()

/** What a ticket promises: one asset with the requirements of its kind. */
export const AssetSpec = z.discriminatedUnion('kind', [
  z.object({ id: AssetId, kind: z.literal('static_mesh'), description: z.string().default(''), requires: StaticMeshRequirements }).strict(),
  z.object({ id: AssetId, kind: z.literal('skeletal_mesh'), description: z.string().default(''), requires: StaticMeshRequirements.extend({ bones: z.number().int().positive().optional() }) }).strict(),
  z.object({ id: AssetId, kind: z.literal('texture_set'), description: z.string().default(''), requires: TextureSetRequirements }).strict(),
  z.object({ id: AssetId, kind: z.literal('audio_clip'), description: z.string().default(''), requires: AudioClipRequirements }).strict(),
  z.object({ id: AssetId, kind: z.literal('audio_event'), description: z.string().default(''), requires: AudioEventRequirements }).strict(),
  z.object({ id: AssetId, kind: z.literal('blueprint'), description: z.string().default(''), requires: BlueprintRequirements }).strict(),
  z.object({ id: AssetId, kind: z.literal('level_placement'), description: z.string().default(''), requires: LevelPlacementRequirements }).strict(),
  z.object({ id: AssetId, kind: z.literal('test_result'), description: z.string().default(''), requires: TestResultRequirements }).strict(),
])
export type AssetSpec = z.infer<typeof AssetSpec>
export type SpecOf<K extends AssetKind> = Extract<AssetSpec, { kind: K }>

// ---- Records: what a worker delivered ----------------------------------------------------------------------------------

/** How an asset came to exist. Tracked for every asset, because generated and library content carries licence terms. */
export const Provenance = z.object({
  method: z.enum(['procedural', 'generative', 'library', 'manual', 'simulated']),
  /** The tool that made it: blender 4.3, numpy synth, a text-to-3D service. */
  tool: z.string(),
  /** For generative content: the model or service, and the prompt it was given. */
  model: z.string().optional(),
  prompt: z.string().optional(),
  /** SPDX id or a short licence name; `proprietary` for studio-owned work. */
  license: z.string().default('proprietary'),
  /** The script that reproduces the asset, relative to the ticket directory; required for procedural assets. */
  recipe: z.string().optional(),
}).strict()
export type Provenance = z.infer<typeof Provenance>

export const AssetFile = z.object({
  /** Path relative to the ticket's directory, or a /Game/ object path for assets that live only in the engine. */
  path: z.string().min(1),
  role: z.enum(['source', 'export', 'recipe', 'preview', 'report', 'engine']),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict()
export type AssetFile = z.infer<typeof AssetFile>

/**
 * What a worker delivered for one spec. `facts` are measurements the DCC inspection script took (triangle counts, bounds,
 * collision object names, sample rate), never the worker's own claims: contracts compare facts with the spec.
 */
export const AssetRecord = z.object({
  id: AssetId,
  kind: AssetKind,
  files: z.array(AssetFile).min(1),
  facts: z.record(z.string(), z.unknown()).default({}),
  provenance: Provenance,
  /** Set by the ingest stage, never by a worker: the engine object and what the engine-side check measured. */
  engine: z.object({ objectPath: z.string().regex(/^\/Game\//), facts: z.record(z.string(), z.unknown()).default({}) }).strict().optional(),
}).strict()
export type AssetRecord = z.infer<typeof AssetRecord>

// ---- Reports: what a worker says at the end of a turn --------------------------------------------------------------------

/** Same statuses as dsh-superagent's Report: `ready` hands the assets to the contract gate. */
export const ReportStatus = z.enum(['progress', 'ready', 'blocked', 'failed', 'dropped'])
export type ReportStatus = z.infer<typeof ReportStatus>

export const WorkerResult = z.object({
  status: ReportStatus,
  summary: z.string(),
  assets: z.array(AssetRecord).default([]),
  /** One concrete question for a person; makes the ticket wait for an answer (Attention). */
  question: z.string().optional(),
}).strict()
export type WorkerResult = z.infer<typeof WorkerResult>

// ---- Plan: tickets wired by the assets they exchange -------------------------------------------------------------------

export const TicketSpec = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/, 'ticket id must be a short kebab-case name'),
  domain: Domain,
  title: z.string().min(1),
  /** What to make, in the brief's words; the preset's prompt supplies how. */
  instructions: z.string().min(1),
  produces: z.array(AssetSpec).default([]),
  /** Asset ids produced by other tickets; the ticket starts only once each passed its contract (and review, if required). */
  consumes: z.array(AssetId).default([]),
  /** Extra ordering without an asset between the tickets. Prefer `consumes`: an edge without an asset carries no contract. */
  after: z.array(z.string()).default([]),
  /** Files or depot paths the ticket writes; locked for its whole run, so two tickets never edit one binary asset. */
  locks: z.array(z.string()).default([]),
  /** `human` holds its assets for a person's approval before any consumer starts, such as art-direction sign-off. */
  review: z.enum(['auto', 'human']).default('auto'),
  /** How many times a contract failure goes back to the worker before the ticket waits for a person. */
  maxRevisions: z.number().int().min(0).max(5).default(2),
}).strict()
export type TicketSpec = z.infer<typeof TicketSpec>

export const Plan = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/, 'plan id must be a kebab-case name of 2 to 61 characters'),
  brief: z.string().min(1),
  /** /Game/ folder the plan's engine assets go under, such as /Game/Props/VintageRadio. */
  contentRoot: z.string().regex(/^\/Game\//).default('/Game/Generated'),
  tickets: z.array(TicketSpec).min(1),
}).strict()
export type Plan = z.infer<typeof Plan>

// ---- Runtime state ------------------------------------------------------------------------------------------------------

/**
 * A ticket's state. Unlike dsh-superagent, where each Ticket stands alone, these tickets wait on each other:
 * `waiting` (its inputs are not ready) → `queued` (ready; waiting for a tool slot or a lock) → `running` → `validating`
 * → `review` (only with review: human) → `done`. `revising` is a running revision after a contract failure.
 * `attention` (a question or exhausted revisions), `blocked`, `failed` and `dropped` wait for a person.
 */
export const TicketState = z.enum(['waiting', 'queued', 'running', 'validating', 'revising', 'review', 'done', 'attention', 'blocked', 'failed', 'dropped'])
export type TicketState = z.infer<typeof TicketState>

export interface Violation {
  asset: string
  rule: string
  message: string
}

export interface AssignmentRecord {
  id: string
  /** 0 for the first run; each contract failure that goes back to the worker adds one. */
  revision: number
  startedAt: string
  endedAt?: string
  result?: WorkerResult
  violations?: Violation[]
}

export interface TicketRun {
  id: string
  state: TicketState
  assignments: AssignmentRecord[]
  /** Assets that passed their contract, by id. */
  delivered: Record<string, AssetRecord>
  /** The question or reason a person must act on; cleared when they do. */
  attention?: string
  /** Free-text answers and approvals from people, delivered to the next assignment. */
  notes: string[]
  updatedAt: string
}

export interface PlanRun {
  planId: string
  plan: Plan
  tickets: Record<string, TicketRun>
  locks: LockLease[]
  events: RunEvent[]
  startedAt: string
  updatedAt: string
}

export interface LockLease {
  path: string
  ticketId: string
  backend: string
  acquiredAt: string
}

export interface RunEvent {
  at: string
  ticketId?: string
  type: string
  detail: string
}
