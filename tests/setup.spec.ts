import { describe, expect, it } from 'vitest'
import { checkSetup, configureUnrealProject, findBlenders, findProjects, findUnrealEngines, iniValue, installBlenderAddon, setIniValue, unrealProjectState, type SetupEnv } from '../src/setup/index.ts'

/** A fake machine: a file map, and scripted command results. */
function machine(platform: NodeJS.Platform, files: Record<string, string>, commands: Record<string, { status: number; stdout: string; stderr?: string }> = {}) {
  const fs = { ...files }
  const ran: string[] = []
  const sys: SetupEnv = {
    platform, home: platform === 'win32' ? 'C:\\Users\\dev' : '/home/dev',
    env: platform === 'win32' ? { ProgramFiles: 'C:\\Program Files', ProgramData: 'C:\\ProgramData', APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' } : {},
    run: (command, args) => {
      ran.push([command, ...args].join(' '))
      const key = Object.keys(commands).find(prefix => [command, ...args].join(' ').startsWith(prefix))
      return key ? { stderr: '', ...commands[key]! } : { status: 1, stdout: '', stderr: 'not found' }
    },
    exists: path => path in fs || Object.keys(fs).some(file => file.startsWith(`${path}/`)),
    readDir: path => [...new Set(Object.keys(fs).filter(file => file.startsWith(`${path}/`)).map(file => file.slice(path.length + 1).split('/')[0]!))],
    readFile: path => { if (!(path in fs)) throw new Error(`ENOENT ${path}`); return fs[path]! },
    writeFile: (path, text) => { fs[path] = text },
    copyFile: (from, to) => { fs[to] = fs[from]! },
    reachable: async () => false,
  }
  return { sys, fs, ran }
}
// join() uses the host's separator; the fake file map uses '/', which the Linux test host also uses.
const W = 'C:\\Program Files'

describe('setup detection', () => {
  it('finds Blender versions on Windows, newest first', () => {
    const { sys } = machine('win32', {
      [`${W}/Blender Foundation/Blender 3.6/blender.exe`]: '', [`${W}/Blender Foundation/Blender 4.3/blender.exe`]: '',
    })
    expect(findBlenders(sys).map(item => item.version)).toEqual(['4.3', '3.6'])
  })

  it('finds Unreal engines from the Epic launcher manifest and the default folder', () => {
    const { sys } = machine('win32', {
      'C:\\ProgramData/Epic/UnrealEngineLauncher/LauncherInstalled.dat': JSON.stringify({ InstallationList: [
        { InstallLocation: 'D:/Epic/UE_5.4', AppName: 'UE_5.4' }, { InstallLocation: 'D:/Games/Fortnite', AppName: 'Fortnite' }] }),
      'D:/Epic/UE_5.4/Engine/Binaries/Win64/UnrealEditor.exe': '',
      [`${W}/Epic Games/UE_5.5/Engine/Binaries/Win64/UnrealEditor.exe`]: '',
    })
    expect(findUnrealEngines(sys).map(item => item.version)).toEqual(['5.5', '5.4'])
  })

  it('finds .uproject files without walking into build folders', () => {
    const { sys } = machine('linux', { '/work/Game/Game.uproject': '{}', '/work/Game/Intermediate/Stale/Stale.uproject': '{}', '/work/Other/Tools/Tools.uproject': '{}' })
    expect(findProjects(sys, '/work').sort()).toEqual(['/work/Game/Game.uproject', '/work/Other/Tools/Tools.uproject'])
  })
})

describe('Unreal project setup', () => {
  const uproject = '/work/Game/Game.uproject'
  const ini = '/work/Game/Config/DefaultEngine.ini'

  it('enables the plugins and remote execution, keeping backups and other settings', () => {
    const { sys, fs } = machine('linux', {
      [uproject]: JSON.stringify({ FileVersion: 3, EngineAssociation: '5.4', Plugins: [{ Name: 'ModelingToolsEditorMode', Enabled: true }, { Name: 'PythonScriptPlugin', Enabled: false }] }),
      [ini]: '[/Script/EngineSettings.GameMapsSettings]\r\nGameDefaultMap=/Game/Maps/Main\r\n',
    })
    expect(unrealProjectState(sys, uproject)).toMatchObject({ engine: '5.4', plugins: { PythonScriptPlugin: false, EditorScriptingUtilities: false }, remoteExecution: false })
    const steps = configureUnrealProject(sys, uproject)
    expect(steps).toEqual(['Enabled PythonScriptPlugin in Game.uproject', 'Enabled EditorScriptingUtilities in Game.uproject',
      'Turned on Python remote execution in Config/DefaultEngine.ini', 'Restart the Unreal Editor so the plugins and the setting load'])
    expect(unrealProjectState(sys, uproject)).toMatchObject({ plugins: { PythonScriptPlugin: true, EditorScriptingUtilities: true }, remoteExecution: true })
    expect(JSON.parse(fs[uproject]!).Plugins).toHaveLength(3)
    expect(fs[`${uproject}.bak`]).toContain('"Enabled":false')
    expect(fs[ini]).toContain('GameDefaultMap=/Game/Maps/Main\r\n\r\n[/Script/PythonScriptPlugin.PythonScriptPluginSettings]\r\nbRemoteExecution=True')
    expect(configureUnrealProject(sys, uproject)).toEqual(['The project was already set up'])
  })

  it('reads and writes ini keys inside their section only', () => {
    const text = '[A]\nkey=1\n[B]\nkey=2\n'
    expect(iniValue(text, '[B]', 'key')).toBe('2')
    expect(setIniValue(text, '[A]', 'key', '9')).toBe('[A]\nkey=9\n[B]\nkey=2\n')
    expect(setIniValue(text, '[B]', 'other', 'x')).toBe('[A]\nkey=1\n[B]\nother=x\nkey=2\n')
  })
})

describe('Blender addon install', () => {
  it('installs with blender-mcp\'s own installer, then enables it in Blender\'s preferences', () => {
    const { sys, ran } = machine('linux', {}, {
      'uvx mcp-for-blender@2.2.6 install-addon': { status: 0, stdout: 'installed' },
      '/usr/bin/blender -b --python-expr': { status: 0, stdout: 'HARNESS_ADDON_ENABLED\n' },
    })
    const steps = installBlenderAddon(sys, { version: '4.3', path: '/usr/bin/blender' })
    expect(ran[0]).toBe('uvx mcp-for-blender@2.2.6 install-addon --addons-dir /home/dev/.config/blender/4.3/scripts/addons')
    expect(ran[1]).toContain('addon_utils.enable("blender_mcp", default_set=True, persistent=True)')
    expect(steps.at(-1)).toContain('click Connect')
  })

  it('reports a Blender that could not enable the addon', () => {
    const { sys } = machine('linux', {}, { 'uvx': { status: 0, stdout: '' }, '/usr/bin/blender': { status: 1, stdout: 'ModuleNotFoundError' } })
    expect(() => installBlenderAddon(sys, { version: '4.3', path: '/usr/bin/blender' })).toThrow(/could not enable it: ModuleNotFoundError/)
  })
})

describe('checkSetup', () => {
  it('lists what is ready and what to fix, in plain lines', async () => {
    const { sys } = machine('linux', {
      '/usr/bin/blender': '', '/home/dev/.config/blender/4.3/scripts/addons/blender_mcp.py': '',
      '/work/Game/Game.uproject': JSON.stringify({ EngineAssociation: '5.4', Plugins: [] }),
    }, { 'uvx --version': { status: 0, stdout: 'uvx 0.8.4' }, '/usr/bin/blender --version': { status: 0, stdout: 'Blender 4.3.2' } })
    const report = await checkSetup(sys, { projectDir: '/work', editors: async () => [] })
    expect(report.ok).toBe(false)
    expect(report.lines).toEqual([
      'ok   uv 0.8.4 (runs the Blender connection)',
      'ok   Blender 4.3 with the MCP addon (/usr/bin/blender)',
      'note Blender is not connected right now: open Blender, press N, BlenderMCP tab, Connect',
      'note no Unreal Engine found (source builds are not detected on Linux)',
      'todo Game.uproject needs PythonScriptPlugin, EditorScriptingUtilities, remote execution; harness_setup_unreal_project turns them on',
      'note no Unreal Editor is answering right now; open your project in the editor',
    ])
  })
})
