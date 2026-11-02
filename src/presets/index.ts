/**
 * Worker presets and machine profiles.
 *
 * A preset (presets/*.json, checked in) says what a domain's worker may use: its tools, its MCP servers, its prompt, and
 * the tool pool it occupies. It never holds machine paths: those are `${VAR}` references, resolved from a profile
 * (profiles/*.json, one per workstation or build agent), so the same preset runs on every artist's machine and on CI.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { Domain } from '../core/model.ts'

const McpServer = z.union([
  z.object({ command: z.string(), args: z.array(z.string()).default([]), env: z.record(z.string(), z.string()).default({}) }).strict(),
  z.object({ type: z.enum(['http', 'sse']), url: z.string(), headers: z.record(z.string(), z.string()).default({}) }).strict(),
])

export const Preset = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/),
  domain: Domain,
  description: z.string(),
  /** The domain prompt, relative to the repository root; the shared worker prompt is always added before it. */
  prompt: z.string(),
  /** Agent-side tools the worker may call, by the executor's names. Everything else is denied. */
  tools: z.array(z.string()),
  mcpServers: z.record(z.string(), McpServer).default({}),
  env: z.record(z.string(), z.string()).default({}),
  /** The tool pool a running worker occupies; the profile sets each pool's size, such as one live Unreal Editor. */
  pool: z.string(),
  /** Profile variables the preset cannot run without; checked before launch, not discovered mid-ticket. */
  requires: z.array(z.string()).default([]),
  /** Commands the worker may not run: publishing is the host's job, after the contract passed. */
  blockedCommands: z.array(z.string()).default([]),
}).strict()
export type Preset = z.infer<typeof Preset>

export const Profile = z.object({
  name: z.string(),
  os: z.enum(['windows', 'linux', 'macos']),
  vars: z.record(z.string(), z.string()).default({}),
  /** Concurrent workers per pool; a pool missing here runs one at a time. */
  pools: z.record(z.string(), z.number().int().min(0)).default({}),
  locks: z.object({ backend: z.enum(['memory', 'perforce', 'git-lfs']).default('memory'), cwd: z.string().optional() }).strict().default({}),
  /**
   * How to start an agent worker. Placeholders: {prompt} the prompt text, {promptFile}, {mcpConfig} the MCP config path,
   * {tools} comma-separated allowed tools, {dir} the ticket directory, {model}.
   */
  agent: z.object({
    command: z.array(z.string()).min(1),
    model: z.string().optional(),
    timeoutMinutes: z.number().positive().default(60),
    /** Maps a preset's generic tool names to the agent's own, such as bash → Bash; one may map to several, comma-separated. */
    toolNames: z.record(z.string(), z.string()).default({}),
    /** How the agent names an MCP server's tools in its allowlist, such as mcp__{server}; omitted when the agent needs none. */
    mcpToolPattern: z.string().optional(),
  }).strict().optional(),
}).strict()
export type Profile = z.infer<typeof Profile>

export function loadPresets(dir: string): Map<Domain, Preset> {
  const presets = new Map<Domain, Preset>()
  for (const file of readdirSync(dir).filter(name => name.endsWith('.json')).sort()) {
    const preset = Preset.parse(JSON.parse(readFileSync(join(dir, file), 'utf8')))
    if (presets.has(preset.domain)) throw new Error(`two presets for domain ${preset.domain}: ${presets.get(preset.domain)!.name} and ${preset.name}`)
    presets.set(preset.domain, preset)
  }
  return presets
}

export function loadProfile(path: string): Profile {
  return Profile.parse(JSON.parse(readFileSync(resolve(path), 'utf8')))
}

/** Replaces ${VAR} with the profile's value, then the process environment; an unknown variable is an error, not "". */
export function substitute(text: string, vars: Record<string, string>, env: NodeJS.ProcessEnv = process.env): string {
  return text.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
    const value = vars[name] ?? env[name]
    if (value === undefined) throw new Error(`variable ${name} is not set in the profile or the environment`)
    return value
  })
}

export interface ResolvedPreset {
  preset: Preset
  env: Record<string, string>
  /** The MCP client configuration to hand to the agent, with every variable resolved. */
  mcpConfig: { mcpServers: Record<string, unknown> }
}

/** Resolves a preset on a profile; lists every missing variable at once. */
export function resolvePreset(preset: Preset, profile: Profile, env: NodeJS.ProcessEnv = process.env): ResolvedPreset {
  const missing = preset.requires.filter(name => profile.vars[name] === undefined && env[name] === undefined)
  if (missing.length) throw new Error(`preset ${preset.name} needs ${missing.join(', ')} in profile ${profile.name}`)
  const sub = (text: string) => substitute(text, profile.vars, env)
  const subRecord = (record: Record<string, string>) => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, sub(value)]))
  const mcpServers = Object.fromEntries(Object.entries(preset.mcpServers).map(([name, server]) => [name, 'command' in server
    ? { command: sub(server.command), args: server.args.map(sub), env: subRecord(server.env) }
    : { type: server.type, url: sub(server.url), headers: subRecord(server.headers) }]))
  return { preset, env: subRecord(preset.env), mcpConfig: { mcpServers } }
}

/** The allowlist to give the agent: the preset's tools in the agent's own names, plus its MCP servers. */
export function allowedTools(preset: Preset, profile: Profile): string[] {
  const names = profile.agent?.toolNames ?? {}
  const tools = preset.tools.flatMap(tool => (names[tool] ?? tool).split(',').map(name => name.trim()).filter(Boolean))
  const pattern = profile.agent?.mcpToolPattern
  if (pattern) tools.push(...Object.keys(preset.mcpServers).map(server => pattern.replace('{server}', server)))
  return [...new Set(tools)]
}
