// The studio end to end, the way the agent drives it, with real Godot: create a game, read what is next, record the
// concept, check the whole game (data, scripts, self-test, a real run into a battle), simulate every encounter group,
// and (with --export) build the Windows .exe.
//   GODOT_BIN=/path/to/godot node scripts/e2e-studio.ts [work dir] [--export]
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createHarnessServer } from '../src/mcp/server.ts'

const work = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : mkdtempSync(join(tmpdir(), 'e2e-studio-'))
const doExport = process.argv.includes('--export')
const server = createHarnessServer({ projectDir: work })
const client = new Client({ name: 'e2e', version: '1' })
const [a, b] = InMemoryTransport.createLinkedPair()
await Promise.all([server.connect(a), client.connect(b)])
let failed = false
async function call(name: string, args: Record<string, unknown> = {}, expectOk = true) {
  const result = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean }
  const text = result.content[0]!.text
  console.log(`\n### ${name}${result.isError ? ' (error)' : ''}\n${text}`)
  if (expectOk && result.isError) failed = true
  return text
}

await call('studio_new_project', { title: 'Fernvale Tales', pitch: 'A cosy pocket RPG about a knight and a young mage saving their village.' })
await call('studio_next')
await call('studio_design_update', {
  patch: {
    inspirations: ['Final Fantasy IV', 'Dragon Quest'], pillars: ['Short, punchy battles', 'A warm, cosy world', 'Every fight teaches something'],
    concept: { coreLoop: 'Explore a region, fight in its grass, level up, buy gear in town, take on the next region.', setting: 'A sleepy forest village and the wilds around it', tone: 'Warm and funny, a little bittersweet' },
    scope: { firstPlayable: 'The village, the meadow and a wolf boss: about 20 minutes of play.' },
  },
  decision: 'A cosy classic RPG with short battles', why: 'The developer loves FF4 but has little time to play',
})
await call('studio_next')
const check = await call('studio_check')
if (!check.includes('✓ Map walk into a battle')) { console.log('FAIL: the full check did not walk into a battle'); failed = true }
const sim = await call('studio_simulate_battle', { level: 1, runs: 200 })
if (!/slime at level 1: (easy|fair)/.test(sim)) { console.log('FAIL: a lone slime should be easy or fair'); failed = true }
await call('studio_simulate_battle', { enemies: ['wolf'], level: 1, runs: 200 })
await call('studio_design_read', { section: 'phases' })
if (doExport) {
  const built = await call('studio_export', { installTemplates: true })
  const exe = /Built (.+\.exe)\./.exec(built)?.[1]
  if (!exe || !existsSync(exe)) { console.log('FAIL: no .exe was built'); failed = true }
}
await client.close()
console.log(failed ? '\nFAILED' : '\nok')
process.exit(failed ? 1 : 0)
