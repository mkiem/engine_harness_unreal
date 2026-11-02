/**
 * goose as the Worker layer: each assignment becomes a goose recipe run headless (`goose run --recipe`). The preset maps
 * onto the recipe directly: its MCP servers become recipe `extensions`, and the report shape becomes `response.json_schema`,
 * so goose itself refuses to finish without a well-formed report. The result file stays the source of truth.
 *
 * goose is used as a runtime, not forked: routing, dependencies, locks and contracts stay in this harness.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Domain } from '../core/model.ts'
import type { Preset, Profile } from '../presets/index.ts'
import { AgentCliExecutor, type LaunchFiles } from './agent-cli.ts'
import { RESULT_FILE } from './prompt.ts'

export const GOOSE_COMMAND = ['goose', 'run', '--recipe', '{recipe}', '--no-session', '--output-format', 'json']

/** The recipe extensions for a preset's resolved MCP servers, in goose's ExtensionConfig shape. */
export function gooseExtensions(mcpServers: Record<string, unknown>): Record<string, unknown>[] {
  const extensions: Record<string, unknown>[] = [{ type: 'builtin', name: 'developer', timeout: 300 }]
  for (const [name, server] of Object.entries(mcpServers) as [string, Record<string, unknown>][]) {
    if ('command' in server) extensions.push({ type: 'stdio', name, cmd: server.command, args: server.args ?? [], envs: server.env ?? {}, timeout: 600 })
    else extensions.push({ type: 'streamable_http', name, uri: server.url, headers: server.headers ?? {}, timeout: 600 })
  }
  return extensions
}

export function gooseRecipe(files: LaunchFiles, ticketTitle: string, model?: string): Record<string, unknown> {
  return {
    version: '1.0.0',
    title: ticketTitle,
    description: `${files.preset.name}: ${files.preset.description}`,
    instructions: files.prompt,
    prompt: `Carry out the ticket in your instructions, then write ${RESULT_FILE} in the current directory and reply with the same JSON.`,
    extensions: gooseExtensions(files.mcpServers),
    ...(model ? { settings: { goose_model: model } } : {}),
    response: { json_schema: {
      type: 'object',
      required: ['status', 'summary', 'assets'],
      properties: {
        status: { type: 'string', enum: ['ready', 'blocked', 'failed', 'dropped'] },
        summary: { type: 'string' },
        question: { type: 'string' },
        assets: { type: 'array', items: { type: 'object', required: ['id', 'kind', 'files', 'provenance'] } },
      },
    } },
  }
}

export function gooseExecutor(options: { presets: Map<Domain, Preset>; profile: Profile; repoRoot: string }): AgentCliExecutor {
  return new AgentCliExecutor({
    ...options,
    command: options.profile.agent?.command[0] === 'goose' ? options.profile.agent.command : GOOSE_COMMAND,
    prepare: (job, files) => {
      // goose accepts JSON recipes; JSON avoids a YAML dependency and is still valid YAML.
      const recipe = join(job.dir, `recipe.${job.assignmentId}.json`)
      writeFileSync(recipe, JSON.stringify(gooseRecipe(files, job.ticket.title, options.profile.agent?.model), null, 2))
      return { recipe }
    },
  })
}
