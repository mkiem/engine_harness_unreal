/**
 * Shared context, toolset configuration, MCP progress notifications, and elicitation helpers
 * used across all modular MCP tool registrars.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AssetLibrary } from '../assets/library.ts'
import { type Plan } from '../core/model.ts'
import { parsePlan, waves } from '../core/plan.ts'
import type { GodotBridge } from '../godot/bridge.ts'
import type { LockBackend } from '../locks/index.ts'
import type { SetupEnv } from '../setup/index.ts'
import { findStudioProject } from '../studio/project.ts'
import type { UnrealBridge } from '../unreal/bridge.ts'

export const ALL_TOOLSETS = ['pipeline', 'unreal', 'godot', 'assets', 'character', 'studio'] as const
export type ToolsetId = typeof ALL_TOOLSETS[number]

export interface ToolExtra {
  signal?: AbortSignal
  _meta?: { progressToken?: string | number }
  sendNotification?: (notification: { method: string; params?: Record<string, unknown> }) => Promise<void>
}

export interface SharedLockStore extends LockBackend {
  list(): { path: string; owner: string; at: string }[]
}

export interface HarnessServerOptions {
  /** The game project the agent works in; plans, ticket directories and the lock file live under <project>/.harness. */
  projectDir: string
  /** Shared lock store; defaults to <project>/.harness/locks.json (or SQLite when configured). */
  locks?: SharedLockStore
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
  /** Finds and downloads openly licensed assets; tests pass one with a fake fetch. */
  assets?: AssetLibrary
  /** Where the game templates are (templates/ in this repository, or the app's payload). */
  templatesDir?: string
  /** Where the bundled design references live (catalog/loopyhop). */
  catalogDir?: string
  /**
   * Scoped toolsets to expose upfront. Defaults to HARNESS_TOOLSETS, else all toolsets matching `engines`.
   * Reduces context-window tool bloat when an agent only needs e.g. `['studio', 'godot']`.
   */
  toolsets?: ToolsetId[]
  /**
   * When true (or HARNESS_DYNAMIC_TOOLSETS=1), registers the `harness_toolsets` meta-tool and starts with only
   * `initialToolsets` (default: `['pipeline']`) enabled, activating other domains on demand via `tools/listChanged`.
   */
  dynamicToolsets?: boolean
  /** Toolsets initially enabled when `dynamicToolsets` is true. Defaults to `['pipeline']`. */
  initialToolsets?: ToolsetId[]
}

export function enginesFromEnv(value = process.env.HARNESS_ENGINES): ('unreal' | 'godot')[] {
  const wanted = (value ?? 'unreal,godot').split(',').map(item => item.trim().toLowerCase())
  const engines = (['unreal', 'godot'] as const).filter(engine => wanted.includes(engine))
  return engines.length ? [...engines] : ['unreal', 'godot']
}

export function toolsetsFromEnv(value = process.env.HARNESS_TOOLSETS): ToolsetId[] | undefined {
  if (!value?.trim()) return undefined
  const wanted = value.split(',').map(item => item.trim().toLowerCase())
  const valid = ALL_TOOLSETS.filter(id => wanted.includes(id))
  return valid.length ? [...valid] : undefined
}

/** HARNESS_DCC_DIR if set; else dcc/ beside the bundle (the app's payload), else dcc/ in a checkout (src/mcp/../../dcc). */
export function defaultDccDir(): string {
  if (process.env.HARNESS_DCC_DIR) return process.env.HARNESS_DCC_DIR
  const here = dirname(fileURLToPath(import.meta.url))
  for (const candidate of [join(here, 'dcc'), join(here, '..', '..', 'dcc')]) if (existsSync(candidate)) return resolve(candidate)
  return resolve(here, '..', '..', 'dcc')
}

export const text = (body: string, structured?: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: body }],
  ...(structured ? { structuredContent: structured } : {}),
})

export const failure = (body: string) => ({
  content: [{ type: 'text' as const, text: body }],
  isError: true,
})

/** Emits an MCP `notifications/progress` update when the client provided a `progressToken`. */
export async function emitProgress(extra: ToolExtra | undefined, progress: number, total?: number, message?: string): Promise<void> {
  const token = extra?._meta?.progressToken
  if (token === undefined || !extra?.sendNotification) return
  try {
    await extra.sendNotification({
      method: 'notifications/progress',
      params: { progressToken: token, progress, ...(total !== undefined ? { total } : {}), ...(message ? { message } : {}) },
    })
  } catch { /* progress notifications are best-effort */ }
}

/**
 * Uses native MCP elicitation (`elicitation/create`) when the connected client advertises support,
 * returning `'accepted'`, `'declined'`, or `'unsupported'` so callers can fall back to prompt-based confirmation.
 */
export async function elicitConfirmation(server: McpServer, message: string): Promise<'accepted' | 'declined' | 'unsupported'> {
  const caps = server.server.getClientCapabilities()
  if (!caps?.elicitation) return 'unsupported'
  try {
    const response = await server.server.elicitInput({
      message,
      requestedSchema: {
        type: 'object',
        properties: { confirm: { type: 'boolean', title: 'Confirm', description: message, default: true } },
        required: ['confirm'],
      },
    })
    return response.action === 'accept' && response.content?.confirm === true ? 'accepted' : 'declined'
  } catch {
    return 'unsupported'
  }
}

export interface HarnessContext {
  server: McpServer
  root: string
  harnessDir: string
  locks: SharedLockStore
  unreal: UnrealBridge
  sys: SetupEnv
  dccDir: string
  engines: ('unreal' | 'godot')[]
  library: AssetLibrary
  templatesDir: string
  catalogDir: string
  godot: GodotBridge
  godotBinary: () => string | undefined
  resetGodotBinary: () => void
  godotProject: () => string
  within: (path: string) => string
  planPath: (id: string) => string
  loadPlan: (ref: string) => Plan
  savePlan: (plan: Plan) => string
  describePlan: (plan: Plan) => string
  studioProject: (path?: string) => string
  insideProject: (project: string, file: string) => string
  track: (toolset: ToolsetId, tool: RegisteredTool) => RegisteredTool
}

export function createHelpers(root: string, harnessDir: string) {
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
  const studioProject = (path?: string) => {
    const project = path ? within(path) : findStudioProject(root)
    if (!project || !existsSync(join(project, 'design', 'game.json')))
      throw new Error(`no game found in ${path ? within(path) : root}; start one with studio_new_project, or say which folder the game is in`)
    return project
  }
  const insideProject = (project: string, file: string) => {
    const inside = relative(resolve(project), resolve(project, file))
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error(`${file} is outside the game's folder`)
    return inside.replace(/\\/g, '/')
  }
  return { within, planPath, loadPlan, savePlan, describePlan, studioProject, insideProject }
}

