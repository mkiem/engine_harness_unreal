// Real downloads from every downloadable asset source, into a throwaway project: proves the API shapes and download
// links still hold. Run in CI, where these hosts are reachable.
//   node scripts/e2e-assets.ts [work dir]
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AssetLibrary } from '../src/assets/library.ts'

const work = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'e2e-assets-'))
const library = new AssetLibrary()
const failures: string[] = []
async function step(name: string, run: () => Promise<string>) {
  try {
    console.log(`ok   ${name}: ${await run()}`)
  } catch (error) {
    failures.push(name)
    console.log(`FAIL ${name}: ${(error as Error).message}`)
  }
}

await step('kenney search + download tiny-dungeon', async () => {
  const found = await library.search('kenney', 'dungeon')
  const done = await library.download('kenney', found[0]!.id, work)
  if (!done.files.some(file => file.endsWith('.png'))) throw new Error(`no PNG in ${done.files.slice(0, 5).join(', ')}`)
  return `${done.files.length} files`
})
await step('polyhaven search + download a 1k texture', async () => {
  const found = await library.search('polyhaven', 'brick', { kind: 'texture' })
  if (!found.length) throw new Error('no results')
  const done = await library.download('polyhaven', found[0]!.id, work, { resolution: '1k' })
  return `${found[0]!.id}: ${done.files.join(', ')}`
})
await step('ambientcg search + download a 1K-PNG material', async () => {
  const found = await library.search('ambientcg', 'bricks')
  if (!found.length) throw new Error('no results')
  const done = await library.download('ambientcg', found[0]!.id, work)
  return `${found[0]!.id}: ${done.files.length} files`
})
await step('godot asset library search + download', async () => {
  const found = await library.search('godot-assetlib', 'state machine')
  if (!found.length) throw new Error('no results')
  const done = await library.download('godot-assetlib', found[0]!.id, work)
  return `${found[0]!.title} [${done.license}]: ${done.files.length} files`
})
if (failures.length) {
  console.log(`\n${failures.length} source(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nok')
