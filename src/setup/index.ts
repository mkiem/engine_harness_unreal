/**
 * First-run setup: find the developer's Blender, Unreal and game project, and connect them to the app.
 *
 * Checks only read. The two actions (install the Blender addon, configure the Unreal project) change files outside the
 * app, so the agent runs them only after the developer agreed, and each one says exactly what it changed.
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { runCommand, type CommandRunner } from '../locks/index.ts'

/** The blender-mcp release the app runs and installs the addon from; one version for server and addon. */
export const BLENDER_MCP = 'mcp-for-blender@2.2.6'
export const BLENDER_ADDON_MODULE = 'blender_mcp'

export interface SetupEnv {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  home: string
  run: CommandRunner
  exists: (path: string) => boolean
  readDir: (path: string) => string[]
  readFile: (path: string) => string
  writeFile: (path: string, text: string) => void
  copyFile: (from: string, to: string) => void
  reachable: (host: string, port: number) => Promise<boolean>
}

export const systemEnv = (): SetupEnv => ({
  platform: process.platform,
  env: process.env,
  home: homedir(),
  run: runCommand,
  exists: existsSync,
  readDir: path => { try { return readdirSync(path) } catch { return [] } },
  readFile: path => readFileSync(path, 'utf8'),
  writeFile: (path, text) => writeFileSync(path, text),
  copyFile: copyFileSync,
  reachable: (host, port) => new Promise(done => {
    const socket = connect({ host, port, timeout: 800 })
    socket.once('connect', () => { socket.destroy(); done(true) })
    socket.once('timeout', () => { socket.destroy(); done(false) })
    socket.once('error', () => done(false))
  }),
})

export interface Install { version: string; path: string }

// ---- Blender -------------------------------------------------------------------------------------------------------

export function findBlenders(sys: SetupEnv): Install[] {
  const found: Install[] = []
  const add = (path: string, version?: string) => {
    if (sys.exists(path) && !found.some(item => item.path === path)) found.push({ path, version: version ?? blenderVersion(sys, path) })
  }
  if (sys.platform === 'win32') {
    for (const root of [sys.env.ProgramFiles ?? 'C:\\Program Files', 'C:\\Program Files (x86)\\Steam\\steamapps\\common']) {
      const base = join(root, 'Blender Foundation')
      for (const dir of sys.readDir(base)) add(join(base, dir, 'blender.exe'), /(\d+\.\d+)/.exec(dir)?.[1])
      add(join(root, 'Blender', 'blender.exe'))
    }
  } else if (sys.platform === 'darwin') {
    for (const app of ['/Applications', join(sys.home, 'Applications')]) {
      for (const dir of sys.readDir(app).filter(name => /^Blender.*\.app$/.test(name))) add(join(app, dir, 'Contents', 'MacOS', 'Blender'))
    }
  } else {
    for (const path of ['/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender', join(sys.home, '.local', 'bin', 'blender')]) add(path)
    for (const dir of sys.readDir('/opt').filter(name => name.toLowerCase().startsWith('blender'))) add(join('/opt', dir, 'blender'))
  }
  return found.sort((a, b) => compareVersions(b.version, a.version))
}

function blenderVersion(sys: SetupEnv, exe: string): string {
  const out = sys.run(exe, ['--version'])
  return /Blender (\d+\.\d+)/.exec(out.stdout)?.[1] ?? 'unknown'
}

/** Blender's per-user config folder for a version, where scripts/addons lives. */
export function blenderConfigDir(sys: SetupEnv, version: string): string {
  if (sys.platform === 'win32') return join(sys.env.APPDATA ?? join(sys.home, 'AppData', 'Roaming'), 'Blender Foundation', 'Blender', version)
  if (sys.platform === 'darwin') return join(sys.home, 'Library', 'Application Support', 'Blender', version)
  return join(sys.env.XDG_CONFIG_HOME ?? join(sys.home, '.config'), 'blender', version)
}

export function blenderAddonInstalled(sys: SetupEnv, version: string): boolean {
  const dir = join(blenderConfigDir(sys, version), 'scripts', 'addons')
  return sys.exists(join(dir, `${BLENDER_ADDON_MODULE}.py`)) || sys.exists(join(dir, BLENDER_ADDON_MODULE, '__init__.py'))
}

/**
 * Installs the blender-mcp addon for one Blender, with blender-mcp's own installer, then enables it in Blender's saved
 * preferences by running that Blender in the background. The developer still clicks Connect in Blender's MCP tab.
 */
export function installBlenderAddon(sys: SetupEnv, blender: Install, uvx = 'uvx'): string[] {
  const addons = join(blenderConfigDir(sys, blender.version), 'scripts', 'addons')
  const steps: string[] = []
  const install = sys.run(uvx, [BLENDER_MCP, 'install-addon', '--addons-dir', addons])
  if (install.status !== 0) throw new Error(`the addon install failed: ${(install.stderr || install.stdout).trim()}`)
  steps.push(`Installed the MCP for Blender addon into ${addons}`)
  const enable = sys.run(blender.path, ['-b', '--python-expr',
    `import addon_utils, bpy; addon_utils.enable("${BLENDER_ADDON_MODULE}", default_set=True, persistent=True); bpy.ops.wm.save_userpref(); print("HARNESS_ADDON_ENABLED")`])
  if (!enable.stdout.includes('HARNESS_ADDON_ENABLED')) throw new Error(`the addon was copied but Blender could not enable it: ${(enable.stderr || enable.stdout).trim().slice(-600)}`)
  steps.push(`Enabled it in Blender ${blender.version}'s preferences`)
  steps.push('In Blender: press N in the 3D view, open the BlenderMCP tab, and click Connect (or Start MCP Server)')
  return steps
}

// ---- Unreal --------------------------------------------------------------------------------------------------------

export function findUnrealEngines(sys: SetupEnv): Install[] {
  const found: Install[] = []
  const editorOf = (root: string) => sys.platform === 'win32' ? join(root, 'Engine', 'Binaries', 'Win64', 'UnrealEditor.exe')
    : sys.platform === 'darwin' ? join(root, 'Engine', 'Binaries', 'Mac', 'UnrealEditor.app', 'Contents', 'MacOS', 'UnrealEditor')
      : join(root, 'Engine', 'Binaries', 'Linux', 'UnrealEditor')
  const add = (root: string, version: string) => {
    const path = editorOf(root)
    if (sys.exists(path) && !found.some(item => item.path === path)) found.push({ path, version })
  }
  if (sys.platform === 'win32') {
    // The Epic Games Launcher lists every engine it installed, wherever the developer put it.
    const manifest = join(sys.env.ProgramData ?? 'C:\\ProgramData', 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat')
    if (sys.exists(manifest)) {
      try {
        const list = (JSON.parse(sys.readFile(manifest)) as { InstallationList?: { InstallLocation: string; AppName: string }[] }).InstallationList ?? []
        for (const item of list) if (/^UE_\d/.test(item.AppName)) add(item.InstallLocation, item.AppName.slice(3))
      } catch { /* a malformed manifest is not fatal: fall back to the default folder */ }
    }
    const base = join(sys.env.ProgramFiles ?? 'C:\\Program Files', 'Epic Games')
    for (const dir of sys.readDir(base).filter(name => /^UE_\d/.test(name))) add(join(base, dir), dir.slice(3))
  } else if (sys.platform === 'darwin') {
    const base = '/Users/Shared/Epic Games'
    for (const dir of sys.readDir(base).filter(name => /^UE_\d/.test(name))) add(join(base, dir), dir.slice(3))
  }
  return found.sort((a, b) => compareVersions(b.version, a.version))
}

/** .uproject files in `dir` and up to two levels below it. */
export function findProjects(sys: SetupEnv, dir: string, depth = 2): string[] {
  const found: string[] = []
  const walk = (current: string, level: number) => {
    for (const name of sys.readDir(current)) {
      if (name.startsWith('.') || ['Binaries', 'Intermediate', 'Saved', 'DerivedDataCache', 'node_modules'].includes(name)) continue
      const path = join(current, name)
      if (name.endsWith('.uproject')) found.push(path)
      else if (level < depth && !/\.[A-Za-z0-9]{1,8}$/.test(name)) walk(path, level + 1) // a folder: readDir answers [] for a file
    }
  }
  walk(dir, 0)
  return found
}

const PY_SETTINGS = '[/Script/PythonScriptPlugin.PythonScriptPluginSettings]'
const REQUIRED_PLUGINS = ['PythonScriptPlugin', 'EditorScriptingUtilities']

export interface ProjectState {
  uproject: string
  engine?: string
  plugins: Record<string, boolean>
  remoteExecution: boolean
}

export function unrealProjectState(sys: SetupEnv, uproject: string): ProjectState {
  const descriptor = JSON.parse(sys.readFile(uproject)) as { EngineAssociation?: string; Plugins?: { Name: string; Enabled: boolean }[] }
  const plugins = Object.fromEntries(REQUIRED_PLUGINS.map(name => [name, !!descriptor.Plugins?.some(plugin => plugin.Name === name && plugin.Enabled)]))
  const ini = join(dirname(uproject), 'Config', 'DefaultEngine.ini')
  const text = sys.exists(ini) ? sys.readFile(ini) : ''
  return { uproject, engine: descriptor.EngineAssociation, plugins, remoteExecution: iniValue(text, PY_SETTINGS, 'bRemoteExecution')?.toLowerCase() === 'true' }
}

/**
 * Enables the Python Editor Script Plugin and Editor Scripting Utilities in the .uproject, and remote execution in
 * Config/DefaultEngine.ini, keeping a .bak of each file it changes. The editor must restart to pick it up.
 */
export function configureUnrealProject(sys: SetupEnv, uproject: string): string[] {
  const steps: string[] = []
  const raw = sys.readFile(uproject)
  const descriptor = JSON.parse(raw) as { Plugins?: { Name: string; Enabled: boolean }[] } & Record<string, unknown>
  const plugins = descriptor.Plugins ?? []
  let changed = false
  for (const name of REQUIRED_PLUGINS) {
    const entry = plugins.find(plugin => plugin.Name === name)
    if (entry?.Enabled) continue
    if (entry) entry.Enabled = true
    else plugins.push({ Name: name, Enabled: true })
    changed = true
    steps.push(`Enabled ${name} in ${basename(uproject)}`)
  }
  if (changed) {
    sys.copyFile(uproject, `${uproject}.bak`)
    // Unreal writes .uproject files with tabs; keep that so the diff stays small.
    sys.writeFile(uproject, `${JSON.stringify({ ...descriptor, Plugins: plugins }, null, '\t')}\n`)
  }
  const ini = join(dirname(uproject), 'Config', 'DefaultEngine.ini')
  const text = sys.exists(ini) ? sys.readFile(ini) : ''
  if (iniValue(text, PY_SETTINGS, 'bRemoteExecution')?.toLowerCase() !== 'true') {
    if (sys.exists(ini)) sys.copyFile(ini, `${ini}.bak`)
    sys.writeFile(ini, setIniValue(text, PY_SETTINGS, 'bRemoteExecution', 'True'))
    steps.push('Turned on Python remote execution in Config/DefaultEngine.ini')
  }
  if (steps.length) steps.push('Restart the Unreal Editor so the plugins and the setting load')
  else steps.push('The project was already set up')
  return steps
}

export function iniValue(text: string, section: string, key: string): string | undefined {
  let inSection = false
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) inSection = trimmed === section
    else if (inSection) {
      const match = /^([^=;]+)=(.*)$/.exec(trimmed)
      if (match && match[1]!.trim() === key) return match[2]!.trim()
    }
  }
  return undefined
}

export function setIniValue(text: string, section: string, key: string, value: string): string {
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text ? text.split(/\r?\n/) : []
  const start = lines.findIndex(line => line.trim() === section)
  if (start < 0) return `${text.replace(/\s*$/, '')}${text.trim() ? newline + newline : ''}${section}${newline}${key}=${value}${newline}`
  let end = lines.findIndex((line, index) => index > start && line.trim().startsWith('['))
  if (end < 0) end = lines.length
  const existing = lines.findIndex((line, index) => index > start && index < end && line.trim().split('=')[0]?.trim() === key)
  if (existing >= 0) lines[existing] = `${key}=${value}`
  else lines.splice(start + 1, 0, `${key}=${value}`)
  return lines.join(newline)
}

// ---- The whole check -----------------------------------------------------------------------------------------------

export interface SetupReport {
  ok: boolean
  lines: string[]
  blenders: Install[]
  engines: Install[]
  projects: ProjectState[]
}

/** Everything the app needs, each line `ok` or `todo` with the fix. `editors` reports running Unreal editors, if any. */
export async function checkSetup(sys: SetupEnv, options: {
  projectDir?: string
  editors?: () => Promise<{ projectName: string; engineVersion: string }[]>
  godot?: () => { path: string; version: string }[]
  godotProject?: (dir: string) => string | undefined
} = {}): Promise<SetupReport> {
  const lines: string[] = []
  let ok = true
  const todo = (text: string) => { ok = false; lines.push(`todo ${text}`) }

  const uvx = sys.run(sys.platform === 'win32' ? 'uvx.exe' : 'uvx', ['--version'])
  if (uvx.status === 0) lines.push(`ok   uv ${uvx.stdout.trim().replace(/^uvx\s*/, '')} (runs the Blender connection)`)
  else todo('uv not found; it ships with the app, so restart the app, or install it from https://docs.astral.sh/uv/')

  const blenders = findBlenders(sys)
  if (!blenders.length) todo('no Blender found; install Blender 3.6 or later from https://www.blender.org/download/')
  for (const blender of blenders) {
    if (blenderAddonInstalled(sys, blender.version)) lines.push(`ok   Blender ${blender.version} with the MCP addon (${blender.path})`)
    else todo(`Blender ${blender.version} has no MCP addon yet; harness_setup_blender installs it (${blender.path})`)
  }
  if (blenders.length) {
    if (await sys.reachable('127.0.0.1', 9876)) lines.push('ok   Blender is connected (port 9876)')
    else lines.push('note Blender is not connected right now: open Blender, press N, BlenderMCP tab, Connect')
  }

  const engines = findUnrealEngines(sys)
  if (!engines.length) lines.push(sys.platform === 'linux' ? 'note no Unreal Engine found (source builds are not detected on Linux)' : 'todo no Unreal Engine found; install one with the Epic Games Launcher')
  for (const engine of engines) lines.push(`ok   Unreal Engine ${engine.version} (${engine.path})`)
  if (!engines.length && sys.platform !== 'linux') ok = false

  const godot = options.godot?.() ?? []
  const godotProject = options.projectDir ? options.godotProject?.(options.projectDir) : undefined
  if (godot.length) lines.push(`ok   Godot ${godot[0]!.version} (${godot[0]!.path})`)
  else if (godotProject) todo('this is a Godot project but Godot 4 was not found; studio_install_godot installs it')
  else lines.push('note Godot 4 not found (only needed for Godot projects)')
  if (godotProject) lines.push(`ok   Godot project at ${godotProject}`)

  const projects: ProjectState[] = []
  if (options.projectDir) {
    const found = findProjects(sys, options.projectDir)
    if (!found.length) lines.push(`note no .uproject under ${options.projectDir}; open the app in your game project's folder`)
    for (const uproject of found) {
      try {
        const state = unrealProjectState(sys, uproject)
        projects.push(state)
        const missing = [...Object.entries(state.plugins).filter(([, on]) => !on).map(([name]) => name), ...(state.remoteExecution ? [] : ['remote execution'])]
        if (missing.length) todo(`${basename(uproject)} needs ${missing.join(', ')}; harness_setup_unreal_project turns them on`)
        else lines.push(`ok   ${basename(uproject)} is ready for the editor bridge (UE ${state.engine ?? '?'})`)
      } catch (error) {
        todo(`${uproject} could not be read: ${(error as Error).message}`)
      }
    }
  }
  if (options.editors) {
    const editors = await options.editors().catch(() => [])
    if (editors.length) for (const editor of editors) lines.push(`ok   Unreal Editor is open and answering: ${editor.projectName} (UE ${editor.engineVersion})`)
    else lines.push('note no Unreal Editor is answering right now; open your project in the editor')
  }
  return { ok, lines, blenders, engines, projects }
}

function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.split('.').map(part => Number.parseInt(part, 10) || 0)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}
