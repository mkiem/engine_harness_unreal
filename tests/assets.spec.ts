import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { AssetLibrary, polyHavenDownloads, USER_AGENT, type Fetch } from '../src/assets/library.ts'
import { createHarnessServer } from '../src/mcp/server.ts'
import { tempDir } from './fixtures.ts'

function fakeFetch(routes: Record<string, unknown>) {
  const seen: { url: string; agent?: string }[] = []
  const fetch: Fetch = async (url, init) => {
    seen.push({ url, agent: init?.headers?.['User-Agent'] })
    const key = Object.keys(routes).find(prefix => url.startsWith(prefix))
    if (!key) return { ok: false, status: 404, json: async () => ({}), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }
    const body = routes[key]
    const bytes = body instanceof Uint8Array ? body : strToU8(typeof body === 'string' ? body : JSON.stringify(body))
    return { ok: true, status: 200, json: async () => JSON.parse(new TextDecoder().decode(bytes)), text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.slice().buffer }
  }
  return { fetch, seen }
}

const kenneyZip = zipSync({ 'kenney_tiny-dungeon/Tilemap/tilemap.png': strToU8('png'), 'kenney_tiny-dungeon/License.txt': strToU8('CC0') })

describe('asset library', () => {
  it('searches the curated Kenney kits and downloads one, unwrapped, with its licence', async () => {
    const { fetch, seen } = fakeFetch({ 'https://kenney.nl/assets/tiny-dungeon': '<a href="/media/pages/assets/tiny-dungeon/abc/kenney_tiny-dungeon.zip">Download</a>', 'https://kenney.nl/media/': kenneyZip })
    const library = new AssetLibrary({ fetch })
    expect((await library.search('kenney', 'pixel rpg tileset')).map(result => result.id)).toEqual(['tiny-dungeon', 'tiny-town', 'roguelike-rpg-pack'])
    const dir = tempDir()
    const done = await library.download('kenney', 'tiny-dungeon', dir)
    expect(done.files).toEqual(['Tilemap/tilemap.png', 'License.txt'])
    expect(JSON.parse(readFileSync(join(done.dir, 'asset.json'), 'utf8'))).toMatchObject({ source: 'kenney', license: 'CC0', author: 'Kenney' })
    expect(readFileSync(join(done.dir, 'LICENSE.txt'), 'utf8')).toContain('Licence: CC0')
    expect(seen.every(request => request.agent === USER_AGENT)).toBe(true)
  })

  it('filters Poly Haven assets and picks one file per map at the resolution', async () => {
    const { fetch } = fakeFetch({ 'https://api.polyhaven.com/assets': { brick_wall_02: { name: 'Brick Wall 02', type: 1, tags: ['brick', 'wall'], authors: { 'Rob Tuytel': 'All' } }, kloppenheim_06: { name: 'Kloppenheim 06', type: 0, tags: ['sky'] } } })
    expect(await new AssetLibrary({ fetch }).search('polyhaven', 'brick')).toEqual([{ source: 'polyhaven', id: 'brick_wall_02', title: 'Brick Wall 02', license: 'CC0', author: 'Rob Tuytel', kind: 'texture', url: 'https://polyhaven.com/a/brick_wall_02' }])
    const tree = { Diffuse: { '1k': { png: { url: 'https://dl.polyhaven.org/brick_diff_1k.png' }, jpg: { url: 'https://dl.polyhaven.org/brick_diff_1k.jpg' } } }, nor_gl: { '1k': { png: { url: 'https://dl.polyhaven.org/brick_nor_gl_1k.png' } } }, blend: { '1k': { blend: { url: 'x' } } } }
    expect(polyHavenDownloads(tree, 1, '1k').map(file => file.name)).toEqual(['brick_diff_1k.png', 'brick_nor_gl_1k.png'])
    expect(polyHavenDownloads({ gltf: { '1k': { gltf: { url: 'https://dl/x/chair_1k.gltf', include: { 'textures/chair_diff_1k.jpg': { url: 'https://dl/x/t.jpg' } } } } } }, 2, '1k').map(file => file.name)).toEqual(['chair_1k.gltf', 'textures/chair_diff_1k.jpg'])
    expect(() => polyHavenDownloads(tree, 1, '8k')).toThrow(/no 8k files/)
  })

  it('downloads the requested ambientCG variant', async () => {
    const material = zipSync({ 'Bricks059_1K-PNG_Color.png': strToU8('c'), 'Bricks059_1K-PNG_NormalDX.png': strToU8('n') })
    const { fetch } = fakeFetch({
      'https://ambientcg.com/api/v2/full_json?id=Bricks059': { foundAssets: [{ assetId: 'Bricks059', downloadFolders: { default: { downloadFiletypeCategories: { zip: { downloads: [
        { attribute: '2K-JPG', downloadLink: 'https://cdn/2k.zip', fileName: 'Bricks059_2K-JPG.zip' }, { attribute: '1K-PNG', downloadLink: 'https://cdn/1k.zip', fileName: 'Bricks059_1K-PNG.zip' }] } } } } }] },
      'https://cdn/1k.zip': material,
    })
    const done = await new AssetLibrary({ fetch }).download('ambientcg', 'Bricks059', tempDir())
    expect(done.files.sort()).toEqual(['Bricks059_1K-PNG_Color.png', 'Bricks059_1K-PNG_NormalDX.png'])
  })

  it('refuses marketplace sources with how to get their assets instead', async () => {
    await expect(new AssetLibrary({ fetch: fakeFetch({}).fetch }).search('fab', 'rock')).rejects.toThrow(/Epic account/)
  })
})

describe('asset MCP tools', () => {
  it('downloads a Godot add-on into the library and installs it into addons/', async () => {
    const project = tempDir('godot-assets-')
    writeFileSync(join(project, 'project.godot'), 'config_version=5\n')
    const addon = zipSync({ 'dialogue-abc123/addons/tiny_dialogue/plugin.cfg': strToU8('[plugin]'), 'dialogue-abc123/README.md': strToU8('hi') })
    const { fetch } = fakeFetch({
      'https://godotengine.org/asset-library/api/asset?': { result: [{ asset_id: '42', title: 'Tiny Dialogue', author: 'someone', category: 'Scripts', cost: 'MIT' }] },
      'https://godotengine.org/asset-library/api/asset/42': { title: 'Tiny Dialogue', author: 'someone', cost: 'MIT', download_url: 'https://github.com/x/dialogue/archive/abc123.zip', browse_url: 'https://github.com/x/dialogue' },
      'https://github.com/x/dialogue/archive/': addon,
    })
    const server = createHarnessServer({ projectDir: project, assets: new AssetLibrary({ fetch }) })
    const client = new Client({ name: 'test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    const call = async (name: string, args: Record<string, unknown> = {}) => ((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0]!.text
    expect(await call('assets_search', { source: 'godot-assetlib', query: 'dialogue' })).toBe('- 42: Tiny Dialogue [MIT, someone] (Scripts)')
    const downloaded = await call('assets_download', { source: 'godot-assetlib', id: '42' })
    expect(downloaded).toContain('licence MIT, by someone')
    expect(downloaded).toContain('Installed res://addons/tiny_dialogue')
    expect(existsSync(join(project, 'addons', 'tiny_dialogue', 'plugin.cfg'))).toBe(true)
    expect(existsSync(join(project, 'library', 'godot-assetlib', '42', 'asset.json'))).toBe(true)
    expect(await call('assets_sources')).toContain('## Fab (Epic Games), including Quixel Megascans (fab): guide only')
  })
})
