// End-to-end check of the Godot half with real Godot 4: a fresh project with pixel-art defaults, the pixel-hero plan run
// through the orchestrator (simulated workers write a real sprite sheet, scene and script), then real Godot validates
// every script and runs the scene headless; a planted syntax error must be caught with its file and line.
//
//   GODOT_BIN=/path/to/godot node scripts/e2e-godot.ts [work dir]
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator } from '../src/core/orchestrator.ts'
import { Pools } from '../src/core/pools.ts'
import { RunStore } from '../src/core/store.ts'
import { SimulatedExecutor } from '../src/executors/simulated.ts'
import { configurePixelArt, formatErrors, GodotBridge, listScripts } from '../src/godot/bridge.ts'
import { parseTscn, sceneTree } from '../src/godot/tscn.ts'
import { LockManager, MemoryLockBackend } from '../src/locks/index.ts'
import { pixelCharacterPlan, PixelCharacterBrief } from '../src/planner/index.ts'
import { systemEnv } from '../src/setup/index.ts'

const godotBin = process.env.GODOT_BIN
if (!godotBin) throw new Error('set GODOT_BIN to a Godot 4 executable')
const work = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'e2e-godot-'))
const project = join(work, 'pixel_rpg')
mkdirSync(project, { recursive: true })
writeFileSync(join(project, 'project.godot'), 'config_version=5\n\n[application]\n\nconfig/name="Pixel RPG"\nconfig/features=PackedStringArray("4.4")\n')
console.log(configurePixelArt(systemEnv(), project, { width: 320, height: 180, windowScale: 4 }).join('\n'))

const brief = PixelCharacterBrief.parse(JSON.parse(readFileSync(new URL('../examples/pixel-hero/brief.json', import.meta.url), 'utf8')))
const plan = pixelCharacterPlan(brief)
const orchestrator = new Orchestrator({
  plan, store: new RunStore(join(work, 'state')), executor: new SimulatedExecutor({ faults: true }), pools: new Pools(),
  locks: new LockManager(new MemoryLockBackend()), poolOf: domain => domain, projectDir: project,
  onEvent: event => { if (/^(ticket\.(done|revising|attention)|contract\.violation)$/.test(event.type)) console.log(`${event.ticketId}: ${event.type} ${event.detail}`) },
})
const run = await orchestrator.runUntilIdle()
const states = Object.values(run.tickets).map(ticket => ticket.state)
if (states.some(state => state !== 'done')) throw new Error(`plan did not finish: ${states.join(', ')}`)

// The sprite ticket's PNG goes into the project, as a real worker would save it.
const sprite = run.tickets['pixel-hero-sprite']!.delivered.SPR_PixelHero!
mkdirSync(join(project, 'art'), { recursive: true })
writeFileSync(join(project, 'art', 'pixel_hero.png'), readFileSync(sprite.files[0]!.path.startsWith('/') ? sprite.files[0]!.path : join(work, 'state', 'work', 'pixel-hero-sprite', sprite.files[0]!.path)))
console.log(sceneTree(parseTscn(readFileSync(join(project, 'characters', 'pixel_hero.tscn'), 'utf8'))))

const godot = new GodotBridge({ godot: () => godotBin })
// The first run imports the project (creates .godot/), which the checks rely on.
await godot.runHeadless(project, { frames: 1 })
const scripts = listScripts(project)
const checked = await godot.check(project, scripts)
if (checked.errors.length) throw new Error(`scripts failed to parse:\n${formatErrors(checked.errors)}`)
console.log(`real Godot: ${checked.checked} script(s) parse cleanly`)
const ran = await godot.runHeadless(project, { scene: 'res://characters/pixel_hero.tscn', frames: 120 })
if (ran.errors.length) throw new Error(`the scene failed at runtime:\n${formatErrors(ran.errors)}`)
console.log('real Godot: res://characters/pixel_hero.tscn ran 120 frames with no errors')

writeFileSync(join(project, 'characters', 'broken.gd'), 'extends Node\n\nfunc _ready() -> void:\n\tvar x := 1 +\n')
const broken = await godot.check(project, [join(project, 'characters', 'broken.gd')])
if (!broken.errors.some(error => error.file === 'res://characters/broken.gd')) throw new Error(`the planted syntax error was not caught: ${JSON.stringify(broken.errors)}`)
console.log(`real Godot caught the planted error:\n${formatErrors(broken.errors)}`)
console.log('ok')
