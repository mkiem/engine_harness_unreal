import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { formatResult, playInEditorScript, readEditorLog, runScriptFile, UnrealBridge, type RemoteClient } from '../src/unreal/bridge.ts'
import { FakeUnrealEditor } from './fake-unreal.ts'
import { tempDir } from './fixtures.ts'

function fakeClient(nodes: { nodeId: string; data: Record<string, string> }[]) {
  const ran: string[] = []
  let connected: { nodeId: string } | null = null
  const client: RemoteClient = {
    start: async () => {}, stop: () => {}, startSearchingForNodes: () => {},
    get remoteNodes() { return nodes },
    openCommandConnection: async node => { connected = node as { nodeId: string } },
    hasCommandConnection: () => connected !== null,
    closeCommandConnection: () => { connected = null },
    get connectedNode() { return connected },
    runCommand: async code => { ran.push(code); return { success: true, output: [{ type: 'Info', output: `ok ${connected?.nodeId}\n` }], result: 'None' } },
  }
  return { client, ran }
}
const node = (id: string, project: string) => ({ nodeId: id, data: { project_name: project, project_root: `/p/${project}`, engine_version: '5.4', engine_root: '/UE', machine: 'm', user: 'u' } })

describe('UnrealBridge', () => {
  it('connects to the only editor and runs Python there', async () => {
    const { client, ran } = fakeClient([node('a', 'Game')])
    const bridge = new UnrealBridge({ client: () => client, discoveryMs: 10 })
    const result = await bridge.run('print(1)')
    expect(result.editor.projectName).toBe('Game')
    expect(formatResult(result)).toBe('ok a')
    expect(ran).toEqual(['print(1)'])
  })

  it('asks which project when several editors are open, and picks by name or folder', async () => {
    const { client } = fakeClient([node('a', 'Game'), node('b', 'Tools')])
    const bridge = new UnrealBridge({ client: () => client, discoveryMs: 10 })
    await expect(bridge.connect()).rejects.toThrow(/2 editors are open/)
    expect((await bridge.connect('tools')).nodeId).toBe('b')
    expect((await bridge.connect('/p/Game/')).nodeId).toBe('a')
  })

  it('explains how to fix a project when no editor answers', async () => {
    const bridge = new UnrealBridge({ client: () => fakeClient([]).client, discoveryMs: 10 })
    await expect(bridge.run('x')).rejects.toThrow(/Enable Remote Execution/)
  })

  it('formats failures and builds the PIE and script snippets', () => {
    expect(formatResult({ success: false, output: [{ type: 'Warning', output: 'careful\n' }], result: 'Traceback: boom' })).toBe('[Warning] careful\nPython error:\nTraceback: boom')
    expect(playInEditorScript('start')).toContain('editor_request_begin_play()')
    expect(runScriptFile('C:/dcc/x.py', ['--job', 'j.json'])).toContain('sys.argv = ["C:/dcc/x.py","--job","j.json"]')
  })

  it('reads and filters the editor log', () => {
    const root = tempDir()
    mkdirSync(join(root, 'Saved', 'Logs'), { recursive: true })
    writeFileSync(join(root, 'Saved', 'Logs', 'Game.log'), 'LogInit: ok\nLogBlueprint: Error: BP_Radio failed\nLogTemp: fine\n')
    expect(readEditorLog(root, 'Game', { filter: 'error' })).toBe('LogBlueprint: Error: BP_Radio failed')
  })
})

describe('UnrealBridge over the real remote execution protocol', () => {
  let editor: FakeUnrealEditor | undefined
  let bridge: UnrealBridge | undefined
  afterEach(() => {
    bridge?.stop()
    editor?.stop()
  })

  it('discovers a running editor, opens the command channel and runs commands in order', async () => {
    editor = new FakeUnrealEditor({ projectName: 'RadioDemo', projectRoot: '/projects/RadioDemo', respond: code => code.includes('raise')
      ? { success: false, output: [], result: 'Traceback (most recent call last): ValueError' }
      : { success: true, output: [`ran ${code.length} chars`] } })
    await editor.start()
    bridge = new UnrealBridge({ discoveryMs: 3000 })
    const editors = await bridge.editors()
    expect(editors.map(item => item.projectName)).toEqual(['RadioDemo'])
    const [first, second] = await Promise.all([bridge.run('print("a")'), bridge.run(playInEditorScript('status'))])
    expect(first.success).toBe(true)
    expect(formatResult(first)).toBe('ran 10 chars')
    expect(second.editor.projectRoot).toBe('/projects/RadioDemo')
    const failed = await bridge.run('raise ValueError()')
    expect(formatResult(failed)).toContain('Python error:\nTraceback')
    expect(editor.commands.map(command => command.mode)).toEqual(['ExecuteFile', 'ExecuteFile', 'ExecuteFile'])
  })
})
