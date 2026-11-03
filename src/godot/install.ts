/**
 * Installs Godot for people who have never used it: the official release from Godot's GitHub, into Engine Harness's
 * own folder, and the export templates a Windows build needs, unpacked from Godot's archive as it downloads (only the
 * Windows templates are kept, so the 1 GB archive never sits on disk). Nothing is installed system-wide.
 */
import { chmodSync, createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Unzip, UnzipInflate, unzipSync } from 'fflate'

export const GODOT_VERSION = '4.4.1'
const TAG = `${GODOT_VERSION}-stable`
const RELEASES = `https://github.com/godotengine/godot/releases/download/${TAG}`

export const harnessHome = (env: NodeJS.ProcessEnv = process.env) => env.HARNESS_HOME ?? join(homedir(), '.engine-harness')

export interface GodotPaths {
  /** The executable for headless runs (on Windows the console build, so its output can be read). */
  cli: string
  /** The executable that opens a window for the developer to play. */
  gui: string
}

/** Where Engine Harness keeps its own Godot, for each platform. */
export function managedGodot(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): GodotPaths {
  const dir = join(harnessHome(env), 'godot', GODOT_VERSION)
  if (platform === 'win32') return { cli: join(dir, `Godot_v${TAG}_win64_console.exe`), gui: join(dir, `Godot_v${TAG}_win64.exe`) }
  if (platform === 'darwin') { const app = join(dir, 'Godot.app', 'Contents', 'MacOS', 'Godot'); return { cli: app, gui: app } }
  const bin = join(dir, `Godot_v${TAG}_linux.x86_64`)
  return { cli: bin, gui: bin }
}

function releaseAsset(platform: NodeJS.Platform): string {
  if (platform === 'win32') return `Godot_v${TAG}_win64.exe.zip`
  if (platform === 'darwin') return `Godot_v${TAG}_macos.universal.zip`
  if (platform === 'linux') return `Godot_v${TAG}_linux.x86_64.zip`
  throw new Error(`Godot has no official build for ${platform}`)
}

type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer>; body: ReadableStream<Uint8Array> | null }>

/** Downloads and unpacks Godot into Engine Harness's folder; answers its paths. Does nothing when it is already there. */
export async function installGodot(options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; fetch?: Fetch } = {}): Promise<GodotPaths & { installed: boolean }> {
  const platform = options.platform ?? process.platform
  const paths = managedGodot(platform, options.env)
  if (existsSync(paths.cli)) return { ...paths, installed: false }
  const response = await (options.fetch ?? (globalThis.fetch as unknown as Fetch))(`${RELEASES}/${releaseAsset(platform)}`, { headers: { 'User-Agent': 'EngineHarness' } })
  if (!response.ok) throw new Error(`downloading Godot ${GODOT_VERSION} failed: HTTP ${response.status}`)
  const dir = dirname(platform === 'darwin' ? join(paths.cli, '..', '..', '..') : paths.cli)
  for (const [name, content] of Object.entries(unzipSync(new Uint8Array(await response.arrayBuffer())))) {
    if (name.endsWith('/')) continue
    const target = join(dir, name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  if (platform !== 'win32') chmodSync(paths.cli, 0o755)
  if (!existsSync(paths.cli)) throw new Error(`the Godot download did not contain ${paths.cli}`)
  return { ...paths, installed: true }
}

/** Where Godot looks for export templates of this version. */
export function templatesDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  const version = `${GODOT_VERSION}.stable`
  if (platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Godot', 'export_templates', version)
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Godot', 'export_templates', version)
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'godot', 'export_templates', version)
}

export const WINDOWS_TEMPLATES = ['windows_release_x86_64.exe', 'windows_debug_x86_64.exe', 'windows_release_x86_64_console.exe', 'windows_debug_x86_64_console.exe']

export function hasWindowsTemplates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(join(templatesDir(platform, env), 'windows_release_x86_64.exe'))
}

/**
 * Streams Godot's export template archive and keeps only the Windows templates (and version.txt), so a Windows .exe can
 * be built. About 1 GB downloads once; around 200 MB stays on disk.
 */
export async function installWindowsTemplates(options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; fetch?: Fetch; onProgress?: (bytes: number) => void } = {}): Promise<{ dir: string; files: string[] }> {
  const dir = templatesDir(options.platform, options.env)
  if (hasWindowsTemplates(options.platform, options.env)) return { dir, files: [] }
  const response = await (options.fetch ?? (globalThis.fetch as unknown as Fetch))(`${RELEASES}/Godot_v${TAG}_export_templates.tpz`, { headers: { 'User-Agent': 'EngineHarness' } })
  if (!response.ok || !response.body) throw new Error(`downloading the export templates failed: HTTP ${response.status}`)
  mkdirSync(dir, { recursive: true })
  const wanted = new Set([...WINDOWS_TEMPLATES, 'version.txt'])
  const files: string[] = []
  const pending: Promise<void>[] = []
  const unzip = new Unzip(file => {
    const name = file.name.replace(/^templates\//, '')
    if (!wanted.has(name)) return
    const out = createWriteStream(join(dir, name))
    files.push(name)
    pending.push(new Promise<void>((resolve, reject) => {
      out.on('finish', () => resolve())
      out.on('error', reject)
      file.ondata = (error, chunk, final) => {
        if (error) return reject(error)
        out.write(Buffer.from(chunk))
        if (final) out.end()
      }
    }))
    file.start()
  })
  unzip.register(UnzipInflate)
  let bytes = 0
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.length
    options.onProgress?.(bytes)
    unzip.push(value)
  }
  unzip.push(new Uint8Array(0), true)
  await Promise.all(pending)
  if (!files.includes('windows_release_x86_64.exe')) throw new Error('the template archive had no Windows templates')
  return { dir, files }
}
