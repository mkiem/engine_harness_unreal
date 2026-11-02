/**
 * The Unreal bridge: drives the developer's open Unreal Editor through Unreal's built-in Python remote execution
 * (UDP discovery on 239.0.0.1:6766, then a TCP command channel), so no editor plugin has to be compiled or bought.
 * The project needs only the Python Editor Script Plugin with "Enable Remote Execution" on, which the setup tools do.
 *
 * Works with UE 5.x (the protocol exists since 4.26). Epic's own MCP plugin (UE 5.8, experimental) can still be added
 * as a separate extension; this bridge stays the default because it works on every 5.x project.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { RemoteExecution, RemoteExecutionConfig } from 'unreal-remote-execution'

export interface EditorNode {
  nodeId: string
  projectName: string
  projectRoot: string
  engineVersion: string
  engineRoot: string
  machine: string
}

export interface PythonResult {
  success: boolean
  /** Printed and logged lines, in order, with their level. */
  output: { type: string; output: string }[]
  /** The traceback when it failed; the value for EvaluateStatement. */
  result: string
}

export type ExecMode = 'ExecuteFile' | 'ExecuteStatement' | 'EvaluateStatement'

/** The part of the remote-execution client the bridge uses; tests replace it. */
export interface RemoteClient {
  start(): Promise<void>
  stop(): void
  startSearchingForNodes(pingInterval?: number): void
  readonly remoteNodes: { nodeId: string; data: Record<string, string> }[]
  openCommandConnection(node: unknown, stopSearching?: boolean, timeoutMs?: number): Promise<void>
  hasCommandConnection(): boolean
  closeCommandConnection(): void
  readonly connectedNode: { nodeId: string } | null
  runCommand(command: string, unattended?: boolean, execMode?: ExecMode, raiseOnFailure?: boolean): Promise<PythonResult>
}

export interface BridgeOptions {
  client?: () => RemoteClient
  /** How long discovery listens for editors before answering. */
  discoveryMs?: number
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const defaultClient = (): RemoteClient => {
  // Linux receives multicast only on 0.0.0.0; Windows and macOS use the loopback adapter as Unreal does by default.
  const bind = process.platform === 'linux' ? '0.0.0.0' : '127.0.0.1'
  return new RemoteExecution(new RemoteExecutionConfig(0, ['239.0.0.1', 6766], bind, ['127.0.0.1', 6776])) as unknown as RemoteClient
}

export class UnrealBridge {
  private readonly makeClient: () => RemoteClient
  private readonly discoveryMs: number
  private client?: RemoteClient
  private started?: Promise<void>
  /** Serialises commands: one TCP channel, one command at a time. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: BridgeOptions = {}) {
    this.makeClient = options.client ?? defaultClient
    this.discoveryMs = options.discoveryMs ?? 3000
  }

  private async ready(): Promise<RemoteClient> {
    if (!this.client) {
      this.client = this.makeClient()
      this.started = this.client.start().then(() => this.client!.startSearchingForNodes(1000))
    }
    await this.started
    return this.client
  }

  /** The editors answering on this machine, after listening for a moment. */
  async editors(waitMs = this.discoveryMs): Promise<EditorNode[]> {
    const client = await this.ready()
    const deadline = Date.now() + waitMs
    while (!client.remoteNodes.length && Date.now() < deadline) await sleep(100)
    return client.remoteNodes.map(node => ({
      nodeId: node.nodeId,
      projectName: node.data.project_name ?? '',
      projectRoot: node.data.project_root ?? '',
      engineVersion: node.data.engine_version ?? '',
      engineRoot: node.data.engine_root ?? '',
      machine: node.data.machine ?? '',
    }))
  }

  /** The editor commands go to: the one already connected, else the one for `project`, else the only one. */
  async connect(project?: string): Promise<EditorNode> {
    const client = await this.ready()
    const editors = await this.editors()
    if (!editors.length) throw new Error(NOT_FOUND)
    const connected = client.hasCommandConnection() ? editors.find(editor => editor.nodeId === client.connectedNode?.nodeId) : undefined
    if (connected && (!project || matches(connected, project))) return connected
    const candidates = project ? editors.filter(editor => matches(editor, project)) : editors
    if (!candidates.length) throw new Error(`no open editor has project ${project}; open editors: ${editors.map(describe).join('; ')}`)
    if (candidates.length > 1) throw new Error(`${candidates.length} editors are open (${candidates.map(describe).join('; ')}); say which project to use`)
    const target = candidates[0]!
    if (client.hasCommandConnection()) client.closeCommandConnection()
    const node = client.remoteNodes.find(item => item.nodeId === target.nodeId)
    await client.openCommandConnection(node, false, 10_000)
    return target
  }

  /** Runs Python in the editor, one command at a time. */
  run(code: string, options: { project?: string; mode?: ExecMode } = {}): Promise<PythonResult & { editor: EditorNode }> {
    const task = this.queue.then(async () => {
      const editor = await this.connect(options.project)
      const client = await this.ready()
      try {
        const result = await client.runCommand(code, true, options.mode ?? 'ExecuteFile', false)
        return { ...result, editor }
      } catch (error) {
        // A dropped channel (editor closed or restarted) is reopened on the next command.
        if (client.hasCommandConnection()) client.closeCommandConnection()
        throw error
      }
    })
    this.queue = task.catch(() => undefined)
    return task
  }

  stop(): void {
    this.client?.stop()
    this.client = undefined
    this.started = undefined
  }
}

const matches = (editor: EditorNode, project: string) =>
  editor.projectName.toLowerCase() === project.toLowerCase() || editor.projectRoot.toLowerCase().replace(/[\\/]+$/, '') === project.toLowerCase().replace(/[\\/]+$/, '')
const describe = (editor: EditorNode) => `${editor.projectName} (UE ${editor.engineVersion}) at ${editor.projectRoot}`

export const NOT_FOUND = 'No Unreal Editor answered. Open your project in the editor, and make sure the Python Editor Script Plugin is enabled with Project Settings → Plugins → Python → "Enable Remote Execution" ticked (harness_setup_unreal_project does both). Then try again.'

/** Formats a Python result for a model: output lines, then the error if it failed. */
export function formatResult(result: PythonResult): string {
  const lines = result.output.map(line => line.type === 'Info' ? line.output.replace(/\n$/, '') : `[${line.type}] ${line.output.replace(/\n$/, '')}`)
  if (!result.success) lines.push(`Python error:\n${result.result}`)
  else if (result.result && result.result !== 'None') lines.push(`Result: ${result.result}`)
  return lines.join('\n') || '(no output)'
}

/** Python that starts, stops or reports Play in Editor through the LevelEditorSubsystem. */
export function playInEditorScript(action: 'start' | 'stop' | 'status'): string {
  return [
    'import unreal',
    'les = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)',
    action === 'start' ? 'les.editor_request_begin_play()' : action === 'stop' ? 'les.editor_request_end_play()' : 'pass',
    'print("PIE running" if les.is_in_play_in_editor() else "PIE not running")',
  ].join('\n')
}

/** Python that runs a script file in the editor with sys.argv set, as if run from a command line. */
export function runScriptFile(path: string, args: string[] = []): string {
  return [
    'import sys, runpy',
    `sys.argv = ${JSON.stringify([path, ...args])}`,
    `runpy.run_path(${JSON.stringify(path)}, run_name="__main__")`,
  ].join('\n')
}

/**
 * The last lines of the project's editor log (Saved/Logs/<Project>.log), optionally only those matching `filter`;
 * where compile errors, Blueprint warnings and PIE output land.
 */
export function readEditorLog(projectRoot: string, projectName: string, options: { lines?: number; filter?: string } = {}): string {
  const path = join(projectRoot, 'Saved', 'Logs', `${projectName}.log`)
  if (!existsSync(path)) return `no log at ${path}`
  const size = statSync(path).size
  const text = readFileSync(path, 'utf8').slice(Math.max(0, size - 2_000_000))
  let lines = text.split(/\r?\n/)
  if (options.filter) {
    const pattern = new RegExp(options.filter, 'i')
    lines = lines.filter(line => pattern.test(line))
  }
  return lines.slice(-(options.lines ?? 80)).join('\n')
}
