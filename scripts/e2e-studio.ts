// The studio end to end, the way the agent drives it, with real Godot: create a game, read what is next, record the
// concept, paint a monster, write music and a sound, check the whole game (data, scripts, self-test, a real run into a
// battle, the ending), simulate every encounter group and the boss, and (with --export) build the Windows .exe.
// With --server <harness-mcp.mjs> it drives the bundled payload over stdio, as the app does, instead of the sources.
//   GODOT_BIN=/path/to/godot node scripts/e2e-studio.ts [work dir] [--export] [--server dist/payload/harness-mcp.mjs]
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createHarnessServer } from '../src/mcp/server.ts'

const work = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : mkdtempSync(join(tmpdir(), 'e2e-studio-'))
const doExport = process.argv.includes('--export')
const serverIndex = process.argv.indexOf('--server')
const bundled = serverIndex > 0 ? resolve(process.argv[serverIndex + 1]!) : undefined
const client = new Client({ name: 'e2e', version: '1' })
if (bundled) {
  console.log(`Driving the bundled server ${bundled}`)
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [bundled], env: { ...process.env, HARNESS_PROJECT_DIR: work } as Record<string, string>, stderr: 'inherit' }))
} else {
  const server = createHarnessServer({ projectDir: work })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
}
let failed = false
async function call(name: string, args: Record<string, unknown> = {}, expectOk = true) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 1_800_000 }) as { content: { text: string }[]; isError?: boolean }
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
// Art and sound made in the studio: a new monster painted into the enemy sheet, a boss theme and a spell sound.
const slime = ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
  '..........oooooooo', '........oogggggggloo', '.......ogggwwgggwwgo', '.......oggwokgwokggo', '......ogggwwgggwwgggo',
  '......ogggggggggggggo', '.....ogggggggggggggggo', '.....oooooooooooooooo']
const painted = await call('studio_paint', { file: 'art/enemies.png', at: [6, 0], frame: [32, 32], rows: slime, palette: { o: '#181425', g: '#3e8948', l: '#63c74d', w: '#ffffff', k: '#000000' } })
if (!painted.includes('grown to fit')) { console.log('FAIL: painting a seventh enemy should grow the sheet'); failed = true }
await call('studio_preview', { file: 'art/enemies.png', frame: [32, 32] })
await call('studio_music', { file: 'boss', tempo: 160, voices: [{ notes: 'A4 C5 E5 A4 G4:2 E4:2 F4 A4 C5 F4 E4:4' }, { notes: 'A2:2 A2:2 F2:2 G2:2 F2:2 F2:2 E2:4', wave: 'triangle' }] })
await call('studio_sound', { name: 'fire', preset: 'fire' })
const check = await call('studio_check')
if (!check.includes('✓ Map walk into a battle')) { console.log('FAIL: the full check did not walk into a battle'); failed = true }
if (!check.includes('✓ Ending')) { console.log('FAIL: the ending did not run'); failed = true }
const sim = await call('studio_simulate_battle', { level: 1, runs: 200 })
if (!/slime at level 1 \(hero, mage\): (easy|fair)/.test(sim)) { console.log('FAIL: a lone slime should be easy or fair'); failed = true }
await call('studio_simulate_battle', { enemies: ['wolf'], level: 1, runs: 200 })
const boss = await call('studio_simulate_battle', { enemies: ['alpha_wolf'], level: 5, party: ['hero', 'mage', 'ranger'], runs: 200 })
if (!/alpha_wolf at level 5 \(hero, mage, ranger\): (fair|hard)/.test(boss)) { console.log('FAIL: the boss should be fair or hard at level 5 with the full party'); failed = true }
// Story events, played without the screen: the elder's quest (both answers), Tomo's charm, and the boss.
const accept = await call('studio_test_event', { event: 'elder', choices: [0] })
if (!accept.includes('accepted_quest') || !accept.includes('"quest_wolf":"start"')) { console.log('FAIL: accepting the elder\'s quest should set accepted_quest and start the quest'); failed = true }
const decline = await call('studio_test_event', { event: 'elder', choices: [1] })
if (decline.includes('accepted_quest')) { console.log('FAIL: declining the elder should not start the quest'); failed = true }
const charm = await call('studio_test_event', { event: 'kid', flags: ['charm_quest'], quests: { charm: 'found' }, items: { kid_charm: 1 } })
if (!charm.includes('"lucky_ring":1') || !charm.includes('"quest_charm":"done"')) { console.log('FAIL: returning the charm should give the Lucky Ring and finish the quest'); failed = true }
const wolf = await call('studio_test_event', { event: 'great_wolf', map: 'forest' })
if (!wolf.includes('Stopped by a battle against alpha_wolf that ends the game')) { console.log('FAIL: the Great Wolf should start the final battle'); failed = true }
await call('studio_design_read', { section: 'phases' })
if (doExport) {
  const built = await call('studio_export', { installTemplates: true })
  const exe = /Built (.+\.exe)\./.exec(built)?.[1]
  if (!exe || !existsSync(exe)) { console.log('FAIL: no .exe was built'); failed = true }
}
await client.close()
console.log(failed ? '\nFAILED' : '\nok')
process.exit(failed ? 1 : 0)
