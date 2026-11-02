/**
 * The starter asset library: openly licensed assets the agent can find and download into the developer's project, with
 * the source, author and licence written beside every download (asset.json, LICENSE.txt) and in the asset's provenance.
 *
 * Nothing is bundled in the installer: assets download on demand, so the app stays small and the assets current, and no
 * marketplace content is redistributed. Marketplace and account-bound sources (Fab, Freesound, OpenGameArt) are
 * listed with how to get their assets; the agent guides the developer through them instead of downloading.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, relative, sep } from 'node:path'
import { unzipSync } from 'fflate'

export type SourceId = 'polyhaven' | 'ambientcg' | 'kenney' | 'godot-assetlib' | 'fab' | 'freesound' | 'opengameart'

export interface Source {
  id: SourceId
  name: string
  url: string
  /** What the licence lets the developer do with the assets. */
  license: string
  kinds: string[]
  engines: ('unreal' | 'godot' | 'any')[]
  /** `download`: the harness searches and downloads; `guide`: the developer gets the assets with their own account. */
  access: 'download' | 'guide'
  howTo: string
  /** Credit the source asks for, shown with every result. */
  credit?: string
}

export const SOURCES: Source[] = [
  { id: 'polyhaven', name: 'Poly Haven', url: 'https://polyhaven.com', license: 'CC0 (public domain), no attribution required', kinds: ['hdri', 'texture', 'model'], engines: ['any'], access: 'download',
    howTo: 'assets_search source=polyhaven, then assets_download with a resolution such as 1k or 2k.',
    credit: 'Powered by Poly Haven. Its API page asks commercial integrations to agree terms with Poly Haven; the assets themselves are CC0.' },
  { id: 'ambientcg', name: 'ambientCG', url: 'https://ambientcg.com', license: 'CC0 (public domain), no attribution required', kinds: ['material', 'texture', 'hdri'], engines: ['any'], access: 'download',
    howTo: 'assets_search source=ambientcg for PBR materials; download a 1K-PNG or 2K-JPG variant.' },
  { id: 'kenney', name: 'Kenney', url: 'https://kenney.nl/assets', license: 'CC0 (public domain), no attribution required', kinds: ['2d', 'pixel-art', 'tileset', 'ui', 'audio', 'model'], engines: ['any'], access: 'download',
    howTo: 'assets_search source=kenney lists curated game kits (16x16 RPG tiles, UI, sounds, low-poly kits); assets_download fetches the whole kit.' },
  { id: 'godot-assetlib', name: 'Godot Asset Library', url: 'https://godotengine.org/asset-library', license: 'Per add-on, mostly MIT; each result shows its licence', kinds: ['addon', 'script', 'template'], engines: ['godot'], access: 'download',
    howTo: 'assets_search source=godot-assetlib for add-ons such as dialogue systems or state machines; assets_download puts them in addons/.' },
  { id: 'fab', name: 'Fab (Epic Games), including Quixel Megascans', url: 'https://www.fab.com', license: 'Fab licences: use in your own projects; no redistribution of the source files', kinds: ['model', 'material', 'environment', 'blueprint'], engines: ['unreal'], access: 'guide',
    howTo: 'Sign in to Fab with your Epic account and add free or bought assets to your library; in Unreal 5.4+ open the Fab plugin (Window → Fab) and add them to the project. Engine Harness cannot download them for you, and never bundles them.' },
  { id: 'freesound', name: 'Freesound', url: 'https://freesound.org', license: 'Per sound (CC0, CC-BY or CC-BY-NC); filter for CC0 or CC-BY and credit authors', kinds: ['audio'], engines: ['any'], access: 'guide',
    howTo: 'Search freesound.org with the licence filter set to Creative Commons 0 (or Attribution, then credit the author). Downloads need a free account.' },
  { id: 'opengameart', name: 'OpenGameArt', url: 'https://opengameart.org', license: 'Mixed per asset (CC0, CC-BY, CC-BY-SA, GPL); check each one', kinds: ['2d', 'pixel-art', 'audio', 'model'], engines: ['any'], access: 'guide',
    howTo: 'Search with the licence filter (CC0 is simplest). Record the author and licence in the asset\'s provenance; avoid GPL and CC-BY-SA art in closed-source games unless you accept their terms.' },
]

/** Curated Kenney kits for common needs; each is CC0 and downloads as one zip from its page. */
export const KENNEY_KITS: { slug: string; title: string; tags: string[] }[] = [
  { slug: 'tiny-dungeon', title: 'Tiny Dungeon (16x16 dungeon tiles and characters)', tags: ['pixel-art', 'rpg', 'tileset', 'characters', '2d', 'dungeon'] },
  { slug: 'tiny-town', title: 'Tiny Town (16x16 town tiles)', tags: ['pixel-art', 'rpg', 'tileset', 'town', '2d'] },
  { slug: 'roguelike-rpg-pack', title: 'Roguelike/RPG pack (16x16 tiles, characters, items)', tags: ['pixel-art', 'rpg', 'tileset', 'characters', 'items', '2d'] },
  { slug: '1-bit-pack', title: '1-Bit Pack (monochrome tiles and sprites)', tags: ['pixel-art', '1-bit', 'tileset', '2d'] },
  { slug: 'pixel-platformer', title: 'Pixel Platformer (18x18 tiles and characters)', tags: ['pixel-art', 'platformer', 'tileset', '2d'] },
  { slug: 'ui-pack', title: 'UI Pack (buttons, panels, sliders)', tags: ['ui', '2d', 'menu'] },
  { slug: 'pixel-ui-pack', title: 'Pixel UI Pack (pixel-art panels and buttons)', tags: ['ui', 'pixel-art', '2d', 'menu'] },
  { slug: 'game-icons', title: 'Game Icons (input and interface icons)', tags: ['ui', 'icons', '2d'] },
  { slug: 'rpg-audio', title: 'RPG Audio (footsteps, doors, coins, weapons)', tags: ['audio', 'sfx', 'rpg'] },
  { slug: 'interface-sounds', title: 'Interface Sounds (clicks, confirms, errors)', tags: ['audio', 'sfx', 'ui'] },
  { slug: 'music-jingles', title: 'Music Jingles (short musical stingers)', tags: ['audio', 'music'] },
  { slug: 'prototype-textures', title: 'Prototype Textures (grid textures for blockouts)', tags: ['texture', 'prototype', '3d'] },
  { slug: 'furniture-kit', title: 'Furniture Kit (low-poly 3D furniture)', tags: ['model', '3d', 'props', 'interior'] },
  { slug: 'city-kit-commercial', title: 'City Kit Commercial (low-poly 3D buildings)', tags: ['model', '3d', 'city'] },
]

export interface SearchResult {
  source: SourceId
  id: string
  title: string
  license: string
  author?: string
  kind?: string
  url?: string
}

export interface Downloaded {
  source: SourceId
  id: string
  dir: string
  files: string[]
  license: string
  author?: string
  url: string
}

export type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>

/** Poly Haven asks every client to send a unique User-Agent. */
export const USER_AGENT = 'EngineHarness/0.1 (+https://github.com/mkiem/engine_harness_unreal)'

export class AssetLibrary {
  private readonly fetch: Fetch
  constructor(options: { fetch?: Fetch } = {}) {
    this.fetch = options.fetch ?? (globalThis.fetch as unknown as Fetch)
  }

  private async get(url: string): Promise<Awaited<ReturnType<Fetch>>> {
    const response = await this.fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/html, */*' } })
    if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status} for ${url}`)
    return response
  }

  async search(source: SourceId, query: string, options: { kind?: string; godotVersion?: string; limit?: number } = {}): Promise<SearchResult[]> {
    const limit = options.limit ?? 10
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const matches = (text: string) => words.every(word => text.toLowerCase().includes(word))
    switch (source) {
      case 'polyhaven': {
        const type = options.kind === 'model' ? 'models' : options.kind === 'hdri' ? 'hdris' : options.kind === 'texture' ? 'textures' : 'all'
        const assets = await (await this.get(`https://api.polyhaven.com/assets?type=${type}`)).json() as Record<string, { name: string; type: number; tags?: string[]; categories?: string[]; authors?: Record<string, string> }>
        const kinds = ['hdri', 'texture', 'model']
        return Object.entries(assets)
          .filter(([id, asset]) => matches([id, asset.name, ...(asset.tags ?? []), ...(asset.categories ?? [])].join(' ')))
          .slice(0, limit)
          .map(([id, asset]) => ({ source, id, title: asset.name, license: 'CC0', author: Object.keys(asset.authors ?? {}).join(', ') || undefined, kind: kinds[asset.type], url: `https://polyhaven.com/a/${id}` }))
      }
      case 'ambientcg': {
        const url = `https://ambientcg.com/api/v2/full_json?type=Material&sort=Popular&limit=${limit}&q=${encodeURIComponent(query)}`
        const body = await (await this.get(url)).json() as { foundAssets?: { assetId: string; displayName?: string; dataType?: string }[] }
        return (body.foundAssets ?? []).map(asset => ({ source, id: asset.assetId, title: asset.displayName ?? asset.assetId, license: 'CC0', kind: asset.dataType, url: `https://ambientcg.com/view?id=${asset.assetId}` }))
      }
      case 'kenney':
        return KENNEY_KITS.filter(kit => matches([kit.slug, kit.title, ...kit.tags].join(' '))).slice(0, limit)
          .map(kit => ({ source, id: kit.slug, title: kit.title, license: 'CC0', author: 'Kenney', url: `https://kenney.nl/assets/${kit.slug}` }))
      case 'godot-assetlib': {
        const url = `https://godotengine.org/asset-library/api/asset?filter=${encodeURIComponent(query)}&godot_version=${options.godotVersion ?? '4.4'}&max_results=${limit}&type=any`
        const body = await (await this.get(url)).json() as { result?: { asset_id: string; title: string; author?: string; category?: string; cost?: string }[] }
        return (body.result ?? []).map(asset => ({ source, id: asset.asset_id, title: asset.title, license: asset.cost ?? 'see asset page', author: asset.author, kind: asset.category, url: `https://godotengine.org/asset-library/asset/${asset.asset_id}` }))
      }
      default:
        throw new Error(`${source} is not searchable from Engine Harness: ${SOURCES.find(item => item.id === source)?.howTo ?? ''}`)
    }
  }

  /** Downloads one asset into `<libraryDir>/<source>/<id>`, unpacking zips, and writes asset.json and LICENSE.txt. */
  async download(source: SourceId, id: string, libraryDir: string, options: { resolution?: string; format?: string } = {}): Promise<Downloaded> {
    const safeId = id.replace(/[^A-Za-z0-9_.-]/g, '_')
    const dir = join(libraryDir, source, safeId)
    mkdirSync(dir, { recursive: true })
    const files: string[] = []
    const save = (name: string, bytes: Uint8Array) => {
      const target = normalize(join(dir, name))
      if (relative(dir, target).startsWith('..')) throw new Error(`refusing to write outside the library: ${name}`)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, bytes)
      files.push(relative(dir, target).split(sep).join('/'))
    }
    const saveArchiveOrFile = (name: string, bytes: Uint8Array) => {
      if (!name.toLowerCase().endsWith('.zip')) return save(name, bytes)
      const entries = Object.entries(unzipSync(bytes)).filter(([entry]) => !entry.endsWith('/') && !entry.startsWith('__MACOSX/'))
      // Archives often wrap everything in one folder (repo-commit/, kit-name/); drop it so paths start at the content.
      const first = entries[0]?.[0].split('/')[0]
      const wrapped = entries.length > 0 && entries.every(([entry]) => entry.includes('/') && entry.split('/')[0] === first)
      for (const [entry, content] of entries) save(wrapped ? entry.slice(first!.length + 1) : entry, content)
    }
    const bytesOf = async (url: string) => new Uint8Array(await (await this.get(url)).arrayBuffer())
    let license = 'CC0'
    let author: string | undefined
    let url: string

    switch (source) {
      case 'polyhaven': {
        const resolution = options.resolution ?? '1k'
        const info = await (await this.get(`https://api.polyhaven.com/info/${id}`)).json() as { type: number; authors?: Record<string, string> }
        author = Object.keys(info.authors ?? {}).join(', ') || undefined
        const filesTree = await (await this.get(`https://api.polyhaven.com/files/${id}`)).json() as Record<string, unknown>
        url = `https://polyhaven.com/a/${id}`
        for (const download of polyHavenDownloads(filesTree, info.type, resolution, options.format)) saveArchiveOrFile(download.name, await bytesOf(download.url))
        break
      }
      case 'ambientcg': {
        const attribute = options.resolution ? `${options.resolution.toUpperCase()}-${(options.format ?? 'PNG').toUpperCase()}` : '1K-PNG'
        const body = await (await this.get(`https://ambientcg.com/api/v2/full_json?id=${encodeURIComponent(id)}&include=downloadData`)).json() as { foundAssets?: { downloadFolders?: Record<string, { downloadFiletypeCategories?: Record<string, { downloads?: { attribute: string; downloadLink: string; fileName: string }[] }> }> }[] }
        const downloads = Object.values(body.foundAssets?.[0]?.downloadFolders ?? {}).flatMap(folder => Object.values(folder.downloadFiletypeCategories ?? {}).flatMap(category => category.downloads ?? []))
        const pick = downloads.find(item => item.attribute === attribute) ?? downloads.find(item => item.attribute.startsWith('1K')) ?? downloads[0]
        if (!pick) throw new Error(`ambientCG has no downloads for ${id}`)
        url = `https://ambientcg.com/view?id=${id}`
        saveArchiveOrFile(pick.fileName, await bytesOf(pick.downloadLink))
        break
      }
      case 'kenney': {
        url = `https://kenney.nl/assets/${id}`
        const page = await (await this.get(url)).text()
        const zip = kenneyZipLink(page)
        if (!zip) {
          const around = /.{0,160}download.{0,160}/is.exec(page)?.[0].replace(/\s+/g, ' ') ?? page.slice(0, 200)
          throw new Error(`no download link on ${url}; download it from the page and put it in ${dir} (page near "download": ${around})`)
        }
        author = 'Kenney'
        saveArchiveOrFile(zip.split('/').pop()!, await bytesOf(new URL(zip, url).toString()))
        break
      }
      case 'godot-assetlib': {
        const asset = await (await this.get(`https://godotengine.org/asset-library/api/asset/${encodeURIComponent(id)}`)).json() as { title: string; author?: string; cost?: string; download_url?: string; browse_url?: string }
        if (!asset.download_url) throw new Error(`the Godot Asset Library lists no download for ${id}`)
        license = asset.cost ?? 'see asset page'
        author = asset.author
        url = asset.browse_url ?? `https://godotengine.org/asset-library/asset/${id}`
        saveArchiveOrFile(`${safeId}.zip`, await bytesOf(asset.download_url))
        break
      }
      default:
        throw new Error(`${source} downloads need the developer's own account: ${SOURCES.find(item => item.id === source)?.howTo ?? ''}`)
    }
    const credit = SOURCES.find(item => item.id === source)?.credit
    writeFileSync(join(dir, 'asset.json'), JSON.stringify({ source, id, url, license, author, downloadedAt: new Date().toISOString(), files }, null, 2))
    writeFileSync(join(dir, 'LICENSE.txt'), `${id} from ${SOURCES.find(item => item.id === source)?.name} (${url})\nAuthor: ${author ?? 'see source'}\nLicence: ${license}\n${credit ? `\n${credit}\n` : ''}`)
    return { source, id, dir, files, license, author, url }
  }
}

/**
 * Picks the files to download from Poly Haven's /files tree: for HDRIs one .hdr; for textures one image per map at the
 * resolution (PNG for data maps); for models the .gltf (or .blend) with its include files.
 */
export function polyHavenDownloads(tree: Record<string, unknown>, type: number, resolution: string, format?: string): { name: string; url: string }[] {
  type FileEntry = { url: string; include?: Record<string, { url: string }> }
  const at = (path: string[]): unknown => path.reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], tree)
  const out: { name: string; url: string }[] = []
  const add = (entry: FileEntry | undefined, name: string) => {
    if (!entry?.url) return
    out.push({ name, url: entry.url })
    for (const [path, include] of Object.entries(entry.include ?? {})) out.push({ name: path, url: include.url })
  }
  if (type === 0) {
    const entry = at(['hdri', resolution, format ?? 'hdr']) as FileEntry | undefined
    add(entry, entry?.url.split('/').pop() ?? 'environment.hdr')
  } else if (type === 1) {
    for (const [map, sizes] of Object.entries(tree)) {
      if (['blend', 'gltf', 'mtlx'].includes(map)) continue
      const formats = (sizes as Record<string, Record<string, FileEntry>>)[resolution]
      const entry = formats?.[format ?? 'png'] ?? formats?.jpg ?? formats?.png
      if (entry) add(entry, entry.url.split('/').pop()!)
    }
  } else {
    const model = (at(['gltf', resolution, 'gltf']) ?? at(['blend', resolution, 'blend'])) as FileEntry | undefined
    add(model, model?.url.split('/').pop() ?? 'model')
  }
  if (!out.length) throw new Error(`no ${resolution} files in this Poly Haven asset; try 1k, 2k or 4k`)
  return out
}

/** Where downloads go: res://library in a Godot project, ArtSource/Library in an Unreal project, else .harness/library. */
export function libraryDirFor(projectRoot: string, kind: 'godot' | 'unreal' | 'other'): string {
  if (kind === 'godot') return join(projectRoot, 'library')
  if (kind === 'unreal') return join(projectRoot, 'ArtSource', 'Library')
  return join(projectRoot, '.harness', 'library')
}

/** Copies a downloaded Godot add-on's addons/<name> folders into the project's addons/, answering what it installed. */
export function installGodotAddon(downloadDir: string, project: string): string[] {
  const source = join(downloadDir, 'addons')
  if (!existsSync(source)) throw new Error(`the download has no addons/ folder; copy what you need from ${downloadDir} by hand`)
  const installed: string[] = []
  for (const name of readdirSync(source)) {
    cpSync(join(source, name), join(project, 'addons', name), { recursive: true })
    installed.push(`res://addons/${name}`)
  }
  return installed
}

/** The kit's zip URL on a Kenney asset page, wherever the page puts it: an href, a data attribute, or a bare URL. */
export function kenneyZipLink(page: string): string | undefined {
  const candidates = [...page.matchAll(/(?:href|data-[\w-]+|content)\s*=\s*["']([^"']+?\.zip(?:\?[^"']*)?)["']/gi)].map(match => match[1]!)
    .concat([...page.matchAll(/(https?:\/\/[^\s"'<>()]+?\.zip(?:\?[^\s"'<>()]*)?)/gi)].map(match => match[1]!))
    .concat([...page.matchAll(/["'(](\/[^\s"'<>()]+?\.zip(?:\?[^\s"'<>()]*)?)["')]/gi)].map(match => match[1]!))
  // Prefer the kit's own archive (kenney_<slug>.zip) over anything else zipped on the page.
  return candidates.find(link => /kenney[_-]/i.test(link)) ?? candidates[0]
}
