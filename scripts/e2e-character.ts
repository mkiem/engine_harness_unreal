// End-to-end check of 3D characters from reference images, through the harness MCP server with real Blender (and real
// Godot 4 when GODOT_BIN is set): the sample turnaround sheet is checked, a character is built in every style (mesh,
// textures, skeleton, animations, FBX and GLB, both held to their contracts), and each one is installed into a Godot
// project and loaded headless, which must report its bones, animations and textures.
//
//   HARNESS_BLENDER_PYTHON=/path/to/python-with-bpy [GODOT_BIN=/path/to/godot] node scripts/e2e-character.ts [work dir]
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { decodePngRgba } from '../src/contracts/png.ts'
import { createHarnessServer } from '../src/mcp/server.ts'

if (!process.env.HARNESS_BLENDER_PYTHON && !process.env.BLENDER_BIN) throw new Error('set HARNESS_BLENDER_PYTHON to a Python that can import bpy')
const work = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'e2e-character-'))
mkdirSync(work, { recursive: true })
const godotProject = join(work, 'godot_game')
mkdirSync(godotProject, { recursive: true })
writeFileSync(join(godotProject, 'project.godot'), 'config_version=5\n\n[application]\n\nconfig/name="Characters"\nconfig/features=PackedStringArray("4.4")\n')

const server = createHarnessServer({ projectDir: work })
const client = new Client({ name: 'e2e', version: '1' })
const [a, b] = InMemoryTransport.createLinkedPair()
await Promise.all([server.connect(a), client.connect(b)])
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 900_000 }) as { content: { text: string }[]; isError?: boolean; structuredContent?: Record<string, any> }
  const text = result.content[0]!.text
  console.log(`\n## ${name} ${JSON.stringify(args)}\n${text}`)
  if (result.isError) throw new Error(`${name} failed`)
  return { text, data: result.structuredContent ?? {} }
}

await call('character_reference_guide')
await call('character_image_model')
const styles = (await call('character_styles')).text.split('\n').map(line => /^- (\w+):/.exec(line)?.[1]).filter(Boolean) as string[]
if (styles.length < 4) throw new Error(`expected at least four styles, got ${styles.join(', ')}`)

for (const style of styles) {
  const name = `Hero${style[0]!.toUpperCase()}${style.slice(1)}`
  const refs = await call('character_sample_references', { name })
  if (!refs.data.ready) throw new Error('the sample references were not accepted')
  const built = await call('character_build', { name, style, engine: 'both' })
  const report = built.data as { triangles: number; bones: number; animations: string[]; textures: Record<string, string>; files: { fbx?: string; glb?: string }; dir: string; preview: string }
  if (report.bones < 20) throw new Error(`${name}: ${report.bones} bones`)
  for (const clip of ['idle', 'walk', 'run', 'attack']) if (!report.animations.includes(clip)) throw new Error(`${name}: no ${clip} animation`)
  for (const file of [report.files.fbx!, report.files.glb!, ...Object.values(report.textures), report.preview]) {
    if (!existsSync(join(report.dir, file))) throw new Error(`${name}: ${file} is missing`)
  }
  // The base colour must carry the references' colours, not one flat fill.
  const bc = decodePngRgba(readFileSync(join(report.dir, report.textures.BC!)))
  const colours = new Set<number>()
  const data = bc.rgba
  for (let i = 0; i < data.length; i += 4 * 97) colours.add((data[i]! >> 4) << 8 | (data[i + 1]! >> 4) << 4 | (data[i + 2]! >> 4))
  if (colours.size < 4) throw new Error(`${name}: the base colour texture has only ${colours.size} colours`)
  console.log(`${name}: ${report.triangles} triangles, ${report.bones} bones, ${colours.size} colour bins in the base colour`)

  if (process.env.GODOT_BIN) {
    const installed = await call('character_install', { name, engine: 'godot', project: godotProject })
    const check = installed.data.check as { bones: number; animations: string[]; textured: boolean; height: number; style: string }
    if (check.bones < 20 || !check.textured || check.animations.length < 4 || Math.abs(check.height - 1.8) > 0.3 || check.style !== style) {
      throw new Error(`${name}: Godot sees ${JSON.stringify(check)}`)
    }
  }
}
console.log(`\ncharacter e2e passed: ${styles.join(', ')}${process.env.GODOT_BIN ? ', each loaded in real Godot' : ''}`)
await client.close()
