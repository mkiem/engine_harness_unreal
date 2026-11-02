/**
 * Runs each assignment as one headless agent process: Claude Code, goose, DSH or any CLI agent that can take a prompt and
 * an MCP config. The agent is the Worker layer; the harness keeps the plan, the locks and the contract gate.
 *
 * Contract with the agent: it works in the ticket directory and writes result.json there (see prompts/worker.md).
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WorkerResult, type Domain } from '../core/model.ts'
import type { Executor, Job } from '../core/ports.ts'
import { allowedTools, resolvePreset, type Preset, type Profile } from '../presets/index.ts'
import { renderWorkerPrompt, RESULT_FILE } from './prompt.ts'

export interface AgentCliOptions {
  presets: Map<Domain, Preset>
  profile: Profile
  repoRoot: string
  /** Overrides the profile's agent command, such as for the goose executor. */
  command?: string[]
  /** Writes extra launch files (a goose recipe) and returns placeholder values for the command. */
  prepare?: (job: Job, files: LaunchFiles) => Record<string, string>
}

export interface LaunchFiles {
  preset: Preset
  prompt: string
  promptFile: string
  mcpConfig: string
  mcpServers: Record<string, unknown>
  env: Record<string, string>
}

export class AgentCliExecutor implements Executor {
  private readonly options: AgentCliOptions
  constructor(options: AgentCliOptions) {
    this.options = options
  }

  async run(job: Job): Promise<WorkerResult> {
    const { presets, profile, repoRoot } = this.options
    const preset = presets.get(job.ticket.domain)
    if (!preset) throw new Error(`no preset for domain ${job.ticket.domain}`)
    const command = this.options.command ?? profile.agent?.command
    if (!command) throw new Error(`profile ${profile.name} has no agent command`)

    const resolved = resolvePreset(preset, profile)
    const prompt = renderWorkerPrompt(job, preset, repoRoot)
    const promptFile = join(job.dir, `PROMPT.${job.assignmentId}.md`)
    const mcpConfig = join(job.dir, 'mcp.json')
    writeFileSync(promptFile, prompt)
    writeFileSync(mcpConfig, JSON.stringify(resolved.mcpConfig, null, 2))
    const resultPath = join(job.dir, RESULT_FILE)
    // A result left by an earlier assignment must not be read as this one's.
    if (existsSync(resultPath)) writeFileSync(join(job.dir, `${RESULT_FILE}.previous`), readFileSync(resultPath))
    writeFileSync(resultPath, '')

    const files: LaunchFiles = { preset, prompt, promptFile, mcpConfig, mcpServers: resolved.mcpConfig.mcpServers, env: resolved.env }
    const values: Record<string, string> = {
      prompt, promptFile, mcpConfig, dir: job.dir, tools: allowedTools(preset, profile).join(','), model: profile.agent?.model ?? '',
      ...this.options.prepare?.(job, files),
    }
    const argv = command.map(arg => arg.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole))
    const env = {
      ...process.env, ...resolved.env,
      HARNESS_PLAN: job.plan.id, HARNESS_TICKET: job.ticket.id, HARNESS_ASSIGNMENT: job.assignmentId,
      HARNESS_DIR: job.dir, HARNESS_RESULT: resultPath, HARNESS_BLOCKED_COMMANDS: preset.blockedCommands.join('\n'),
    }
    const timeoutMs = (profile.agent?.timeoutMinutes ?? 60) * 60_000
    const outcome = await runProcess(argv, { cwd: job.dir, env, signal: job.signal, timeoutMs })
    writeFileSync(join(job.dir, `agent.${job.assignmentId}.log`), outcome.output)

    const text = readFileSync(resultPath, 'utf8').trim()
    if (!text) return { status: 'failed', summary: `the agent exited (${outcome.code}) without writing ${RESULT_FILE}: ${tail(outcome.output)}`, assets: [] }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (error) {
      return { status: 'failed', summary: `${RESULT_FILE} is not JSON: ${(error as Error).message}`, assets: [] }
    }
    const parsed = WorkerResult.safeParse(raw)
    if (!parsed.success)
      return { status: 'failed', summary: `${RESULT_FILE} does not match the report shape: ${parsed.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; ')}`, assets: [] }
    return parsed.data
  }
}

const tail = (text: string, length = 400) => text.length > length ? `…${text.slice(-length)}` : text || '(no output)'

export function runProcess(argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs: number }): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const [command, ...args] = argv
    if (!command) return reject(new Error('empty command'))
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    const kill = () => child.kill('SIGTERM')
    const timer = setTimeout(kill, options.timeoutMs)
    options.signal.addEventListener('abort', kill, { once: true })
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      clearTimeout(timer)
      options.signal.removeEventListener('abort', kill)
      resolve({ code, output })
    })
  })
}
