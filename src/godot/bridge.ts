/**
 * The Godot bridge: Godot 4 driven through its own command line, no editor plugin. Scenes are read from their text
 * files (src/godot/tscn.ts); Godot itself is started only to validate scripts and to run the game:
 *
 *   godot --headless --path <project> --check-only --script res://x.gd      validate one script
 *   godot --headless --path <project> [scene] --quit-after <frames>        run briefly and collect errors
 *   godot --path <project> [scene]                                         open a window for the developer to play
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { iniValue, setIniValue, type SetupEnv } from '../setup/index.ts'
import { managedGodot } from './install.ts'

export interface ProcessResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }
export type AsyncRunner = (command: string, args: string[], options: { cwd?: string; timeoutMs: number }) => Promise<ProcessResult>

export const runAsync: AsyncRunner = (command, args, options) => new Promise(resolve => {
  const child = spawn(command, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  let timedOut = false
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const timer = setTimeout(() => { timedOut = true; child.kill() }, options.timeoutMs)
  child.on('error', error => { clearTimeout(timer); resolve({ code: null, stdout, stderr: stderr + String(error), timedOut }) })
  child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }) })
})

// ---- finding Godot -------------------------------------------------------------------------------------------------

export interface GodotInstall { path: string; version: string }

export function findGodot(sys: SetupEnv): GodotInstall[] {
  const candidates: string[] = []
  if (sys.env.GODOT_BIN) candidates.push(sys.env.GODOT_BIN)
  // The Godot that Engine Harness installed for the developer (studio_install_godot), before any other.
  candidates.push(managedGodot(sys.platform, sys.env).cli)
  const pathDirs = (sys.env.PATH ?? sys.env.Path ?? '').split(sys.platform === 'win32' ? ';' : ':').filter(Boolean)
  const names = sys.platform === 'win32' ? ['godot.exe', 'godot4.exe'] : ['godot', 'godot4']
  for (const dir of pathDirs) for (const name of names) candidates.push(join(dir, name))
  const matching = (dir: string, test: RegExp) => sys.readDir(dir).filter(name => test.test(name)).map(name => join(dir, name))
  if (sys.platform === 'win32') {
    const local = sys.env.LOCALAPPDATA ?? join(sys.home, 'AppData', 'Local')
    // winget installs the official zip under its package folder.
    const winget = join(local, 'Microsoft', 'WinGet', 'Packages')
    for (const pkg of sys.readDir(winget).filter(name => name.startsWith('GodotEngine.GodotEngine'))) candidates.push(...matching(join(winget, pkg), /^Godot_v4.*_win64\.exe$/))
    for (const root of [join(sys.env.ProgramFiles ?? 'C:\\Program Files', 'Godot'), join(local, 'Programs', 'Godot'), join(sys.home, 'Godot')]) candidates.push(...matching(root, /^Godot_v4.*\.exe$/i))
    candidates.push(join(sys.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Steam', 'steamapps', 'common', 'Godot Engine', 'godot.windows.opt.tools.64.exe'))
  } else if (sys.platform === 'darwin') {
    candidates.push('/Applications/Godot.app/Contents/MacOS/Godot', join(sys.home, 'Applications', 'Godot.app', 'Contents', 'MacOS', 'Godot'))
  } else {
    candidates.push('/usr/bin/godot', '/usr/local/bin/godot', '/snap/bin/godot', join(sys.home, '.local', 'bin', 'godot'))
  }
  const found: GodotInstall[] = []
  for (const path of [...new Set(candidates)]) {
    if (!sys.exists(path) || found.some(item => item.path === path)) continue
    const out = sys.run(path, ['--version'])
    const version = /^(\d+\.\d+(?:\.\d+)?)/m.exec(out.stdout.trim())?.[1]
    if (version && Number(version.split('.')[0]) >= 4) found.push({ path, version })
  }
  return found
}

// ---- projects ------------------------------------------------------------------------------------------------------

/** The folder holding project.godot: `dir` itself, or one level below it. */
export function findGodotProject(dir: string): string | undefined {
  if (existsSync(join(dir, 'project.godot'))) return dir
  for (const name of safeReadDir(dir)) if (existsSync(join(dir, name, 'project.godot'))) return join(dir, name)
  return undefined
}

const safeReadDir = (dir: string) => { try { return readdirSync(dir) } catch { return [] } }

export function resToPath(project: string, res: string): string {
  return join(project, res.replace(/^res:\/\//, '').split('/').join(sep))
}

export function pathToRes(project: string, path: string): string {
  return `res://${relative(project, path).split(sep).join('/')}`
}

/** GDScript files under the project, skipping .godot/ and addons/ (third-party code is not ours to check). */
export function listScripts(project: string, limit = 200): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of safeReadDir(dir)) {
      if (out.length >= limit) return
      if (name.startsWith('.') || name === 'addons') continue
      const path = join(dir, name)
      if (name.endsWith('.gd')) out.push(path)
      else if (statSync(path).isDirectory()) walk(path)
    }
  }
  walk(project)
  return out
}

export interface GodotError { file?: string; line?: number; message: string }

/** Pulls errors out of Godot's output: script parse errors, runtime SCRIPT ERRORs, and engine ERRORs with their location. */
export function parseGodotErrors(output: string): GodotError[] {
  const errors: GodotError[] = []
  const lines = output.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    const match = /^(?:SCRIPT ERROR|ERROR|Parse Error):\s*(.*)$/.exec(line)
    if (!match) continue
    // Quitting a running scene from a test leaves objects alive; Godot reports that at exit, and it is not a game error.
    if (/resources still in use at exit|ObjectDB instances leaked/.test(match[1]!)) continue
    const location = /(?:at|in)\s*:?\s*(?:\S+\s+)?\(?(res:\/\/[^:)]+):(\d+)\)?/.exec(lines[i + 1] ?? '') ?? /(res:\/\/[^:)\s]+):(\d+)/.exec(line)
    errors.push({ message: match[1]!, file: location?.[1], line: location ? Number(location[2]) : undefined })
  }
  // Godot repeats parse errors (once per pass); report each once.
  return errors.filter((error, index) => errors.findIndex(other => other.message === error.message && other.file === error.file && other.line === error.line) === index)
}

const CHECK_SCRIPT = `extends Node
# Engine Harness: loads each script given on the command line, so compile errors are reported with the project's
# autoloads in place. This folder is temporary.
func _ready() -> void:
	for path in OS.get_cmdline_user_args():
		var script = ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
		if script == null:
			print("CHECK_FAIL " + path)
	print("CHECK_DONE")
	get_tree().quit(0)
`

export const formatErrors = (errors: GodotError[]) =>
  errors.map(error => `- ${error.file ? `${error.file.replace(/^res:\/\//, '')}${error.line ? `:${error.line}` : ''}: ` : ''}${error.message}`).join('\n')

export class GodotBridge {
  private readonly godot: () => string | undefined
  private readonly run: AsyncRunner
  constructor(options: { godot: () => string | undefined; run?: AsyncRunner }) {
    this.godot = options.godot
    this.run = options.run ?? runAsync
  }

  private binary(): string {
    const path = this.godot()
    if (!path) throw new Error('Godot 4 was not found. Install it from https://godotengine.org/download (or winget install GodotEngine.GodotEngine), or set GODOT_BIN to its executable.')
    return path
  }

  /**
   * Validates GDScript files by loading them inside the running project, where its autoload singletons exist (Godot's
   * per-file --check-only compiles a script alone, so every reference to an autoload looks like an error). One Godot run
   * checks every file; answers the errors found, none when all compile.
   */
  async check(project: string, files: string[]): Promise<{ checked: number; errors: GodotError[] }> {
    const godot = this.binary()
    const resPaths = files.map(file => (file.startsWith('res://') ? file : pathToRes(project, file)))
    const dir = join(project, '.harness_check')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'check.gd'), CHECK_SCRIPT)
    writeFileSync(join(dir, 'check.tscn'), '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://.harness_check/check.gd" id="1"]\n\n[node name="Check" type="Node"]\nscript = ExtResource("1")\n')
    try {
      const result = await this.run(godot, ['--headless', '--path', project, 'res://.harness_check/check.tscn', '--', ...resPaths], { timeoutMs: 180_000 })
      const output = `${result.stdout}\n${result.stderr}`
      const errors = parseGodotErrors(output)
      for (const line of output.split(/\r?\n/)) {
        const failed = /^CHECK_FAIL (\S+)/.exec(line.trim())
        if (failed && !errors.some(error => error.file === failed[1])) errors.push({ file: failed[1], message: 'the script does not compile' })
      }
      if (!output.includes('CHECK_DONE') && !errors.length) errors.push({ message: `Godot stopped before checking the scripts (exit ${result.code}${result.timedOut ? ', timed out' : ''})` })
      return { checked: files.length, errors }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  /** Runs the project (or one scene) headless for a number of frames, and answers what it printed and the errors. */
  async runHeadless(project: string, options: { scene?: string; frames?: number } = {}): Promise<{ errors: GodotError[]; output: string; code: number | null; timedOut: boolean }> {
    const args = ['--headless', '--path', project, ...(options.scene ? [options.scene] : []), '--quit-after', String(options.frames ?? 300)]
    const result = await this.run(this.binary(), args, { timeoutMs: 120_000 })
    const output = `${result.stdout}\n${result.stderr}`
    return { errors: parseGodotErrors(output), output: output.trim().split(/\r?\n/).slice(-60).join('\n'), code: result.code, timedOut: result.timedOut }
  }

  /** Runs Godot with these arguments against the project; for imports, exports and the game's own test scenes. */
  async exec(project: string, args: string[], timeoutMs = 180_000): Promise<ProcessResult & { errors: GodotError[] }> {
    const result = await this.run(this.binary(), ['--headless', '--path', project, ...args], { timeoutMs })
    return { ...result, errors: parseGodotErrors(`${result.stdout}\n${result.stderr}`) }
  }

  /** Imports the project's art and sound, as opening it in the editor would; needed once before running it headless. */
  async importProject(project: string): Promise<ProcessResult & { errors: GodotError[] }> {
    return this.exec(project, ['--import'], 300_000)
  }

  /** Opens the game in a window for the developer to play; returns at once. */
  play(project: string, scene?: string): number | undefined {
    const child = spawn(this.binary(), ['--path', project, ...(scene ? [scene] : [])], { detached: true, stdio: 'ignore' })
    child.unref()
    return child.pid
  }
}

// ---- pixel-art project defaults ------------------------------------------------------------------------------------

export interface PixelArtOptions { width: number; height: number; windowScale: number }

/**
 * Sets a project up for crisp pixel art: nearest-neighbour texture filtering, 2D transforms and vertices snapped to
 * pixels, the base resolution as the viewport, scaled to the window by whole numbers. Keeps a .bak of project.godot.
 */
export function configurePixelArt(sys: SetupEnv, project: string, options: PixelArtOptions): string[] {
  const file = join(project, 'project.godot')
  if (!sys.exists(file)) throw new Error(`no project.godot in ${project}`)
  const original = sys.readFile(file)
  const settings: [string, string, string][] = [
    ['[display]', 'window/size/viewport_width', String(options.width)],
    ['[display]', 'window/size/viewport_height', String(options.height)],
    ['[display]', 'window/size/window_width_override', String(options.width * options.windowScale)],
    ['[display]', 'window/size/window_height_override', String(options.height * options.windowScale)],
    ['[display]', 'window/stretch/mode', '"viewport"'],
    ['[display]', 'window/stretch/scale_mode', '"integer"'],
    ['[rendering]', 'textures/canvas_textures/default_texture_filter', '0'],
    ['[rendering]', '2d/snap/snap_2d_transforms_to_pixel', 'true'],
    ['[rendering]', '2d/snap/snap_2d_vertices_to_pixel', 'true'],
  ]
  let text = original
  const changed: string[] = []
  for (const [section, key, value] of settings) {
    if (iniValue(text, section, key) === value) continue
    text = setIniValue(text, section, key, value)
    changed.push(`${key} = ${value}`)
  }
  if (!changed.length) return ['The project already uses the pixel-art settings']
  sys.copyFile(file, `${file}.bak`)
  sys.writeFile(file, text)
  return [`Set in project.godot (backup in project.godot.bak):`, ...changed.map(line => `  ${line}`), 'Reopen the project in the Godot editor if it is open']
}

export function readProjectName(project: string): string {
  try {
    return iniValue(readFileSync(join(project, 'project.godot'), 'utf8'), '[application]', 'config/name')?.replace(/^"|"$/g, '') ?? 'Godot project'
  } catch {
    return 'Godot project'
  }
}
