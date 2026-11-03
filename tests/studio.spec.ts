import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { decodePngRgba, readPng } from '../src/contracts/png.ts'
import { readWav } from '../src/contracts/wav.ts'
import { createHarnessServer } from '../src/mcp/server.ts'
import { compose, noteFrequency, paint, parseNotes, preview, sound } from '../src/studio/make.ts'
import { mergePatch, readDesign, updateDesign } from '../src/studio/design.ts'
import { currentPhase, describeNext, phaseReports } from '../src/studio/phases.ts'
import { checkProjectData, createProject, findStudioProject, placeholdersLeft } from '../src/studio/project.ts'
import type { SetupEnv } from '../src/setup/index.ts'
import { tempDir } from './fixtures.ts'

const TEMPLATES = resolve(import.meta.dirname, '..', 'templates')
const newGame = (title = 'Moonlit Quest') => createProject(TEMPLATES, { title, pitch: 'A tiny RPG', folder: join(tempDir('studio-'), 'game') }).project

describe('a new game project', () => {
  it('fills the template, generates art and sound, and writes the design and AGENTS.md', () => {
    const project = newGame()
    expect(readFileSync(join(project, 'project.godot'), 'utf8')).toContain('config/name="Moonlit Quest"')
    expect(readFileSync(join(project, 'project.godot'), 'utf8')).toContain('window/size/viewport_width=320')
    expect(readFileSync(join(project, 'export_presets.cfg'), 'utf8')).toContain('builds/windows/moonlit_quest.exe')
    expect(JSON.parse(readFileSync(join(project, 'data', 'game.json'), 'utf8')).title).toBe('Moonlit Quest')
    expect(readPng(readFileSync(join(project, 'art', 'tiles.png')))).toMatchObject({ width: 160, height: 16, hardAlpha: true })
    expect(readWav(readFileSync(join(project, 'audio', 'hit.wav'))).seconds).toBeGreaterThan(0.05)
    expect(placeholdersLeft(project)).toContain('art/hero.png')
    expect(readFileSync(join(project, 'AGENTS.md'), 'utf8')).toContain('Run studio_next')
    expect(readDesign(project).phases.project?.status).toBe('done')
    expect(readFileSync(join(project, 'design', 'GAME_DESIGN.md'), 'utf8')).toContain('# Moonlit Quest')
    expect(checkProjectData(project)).toEqual([])
    expect(findStudioProject(join(project, '..'))).toBe(project)
  })

  it('refuses to overwrite a folder that is not empty', () => {
    const project = newGame()
    expect(() => createProject(TEMPLATES, { title: 'Again', folder: project })).toThrow(/already has a game/)
  })

  it('notices replaced placeholder art', () => {
    const project = newGame()
    writeFileSync(join(project, 'art', 'hero.png'), readFileSync(join(project, 'art', 'npcs.png')))
    expect(placeholdersLeft(project)).not.toContain('art/hero.png')
  })

  it('reports broken references between data files in plain words', () => {
    const project = newGame()
    const maps = JSON.parse(readFileSync(join(project, 'maps', 'maps.json'), 'utf8'))
    maps.town.npcs[0].event = 'mayor'
    maps.town.warps[0].to = 'castle'
    writeFileSync(join(project, 'maps', 'maps.json'), JSON.stringify(maps))
    writeFileSync(join(project, 'maps', 'town.txt'), readFileSync(join(project, 'maps', 'town.txt'), 'utf8').replace('~', '%'))
    expect(checkProjectData(project)).toEqual([
      "map town uses '%', which is not in legend.json",
      'NPC elder on town runs event mayor, which is not in events.json',
      'a warp on town leads to map castle, which is not in maps.json',
    ])
  })
})

describe('the deeper RPG data checks', () => {
  const edit = (project: string, file: string, change: (data: any) => void) => {
    const path = join(project, file)
    const data = JSON.parse(readFileSync(path, 'utf8'))
    change(data)
    writeFileSync(path, JSON.stringify(data))
  }

  it('the sample game passes them', () => {
    expect(checkProjectData(newGame())).toEqual([])
  })

  it('catch bad equipment, skills, statuses, elements and enemy AI', () => {
    const project = newGame()
    edit(project, 'data/items.json', items => {
      items.bronze_sword.users = ['ghost']
      items.iron_sword.slot = 'boots'
      items.potion.effect = 'teleport'
      items.flame_sword.element = 'wind'
    })
    edit(project, 'data/skills.json', skills => {
      skills.fire.type = 'spell'
      skills.lullaby.status.id = 'dizzy'
      skills.thunder.target = 'everyone'
    })
    edit(project, 'data/enemies.json', enemies => {
      enemies.wolf.ai = [{ skill: 'howl_loudly', if: { moon: true } }]
      enemies.alpha_wolf.phases[0].below = 50
    })
    const problems = checkProjectData(project)
    for (const expected of [
      'item bronze_sword can be used by ghost, who is not in characters.json',
      'item iron_sword has slot boots; slots are weapon, armor, accessory',
      'item potion has effect teleport; effects are heal, mp, revive, cure, damage, buff (equipment has a "slot", key items "kind": "key")',
      'item flame_sword uses element wind; the elements in rules.json are fire, ice, thunder, holy',
      'skill fire has type spell; skill types are physical, magic, heal, support',
      'skill lullaby names status dizzy, which is not in statuses.json',
      'skill thunder targets everyone; targets are enemy, all_enemies, ally, all_allies, self, ko_ally',
      "enemy wolf's AI uses howl_loudly, which is not in skills.json",
      "enemy wolf's AI has condition moon; conditions are hp_below, hp_above, turn_every, turn_at_least, ally_hurt, ally_down, target_without, self_without",
      `enemy wolf's AI has no rule that always applies; end it with {"skill": "attack"} so it never stands still`,
      'enemy alpha_wolf has a phase with "below" 50; use a fraction of HP between 0 and 1, such as 0.5',
    ]) expect(problems).toContain(expected)
  })

  it('accept new kinds of skills, items and event commands a game declares', () => {
    const project = newGame()
    edit(project, 'data/skills.json', skills => { skills.fire.type = 'summon' })
    edit(project, 'data/events.json', events => { events.elder = [{ shake: 0.5 }] })
    expect(checkProjectData(project).join('\n')).toMatch(/skill fire has type summon[\s\S]*command \(shake\) that is not known/)
    edit(project, 'data/rules.json', rules => { rules.extra_skill_types = ['summon'] })
    const runner = join(project, 'scripts', 'world', 'event_runner.gd')
    writeFileSync(runner, readFileSync(runner, 'utf8').replace('const COMMANDS := ["say",', 'const COMMANDS := ["shake", "say",'))
    const problems = checkProjectData(project).join('\n')
    expect(problems).not.toContain('summon')
    expect(problems).not.toContain('shake')
  })

  it('catch broken events, quests and flags nothing sets', () => {
    const project = newGame()
    edit(project, 'data/events.json', events => {
      events.elder = [
        { say: ['x'.repeat(100)] },
        { dance: true },
        { give: 'golden_goose' },
        { quest: 'wolf', stage: 'halfway' },
        { join: 'dragon' },
        { if: { flag: 'never_set', weather: 'rain' }, then: [{ battle: ['kraken'] }] },
      ]
    })
    const problems = checkProjectData(project)
    for (const expected of [
      `event elder has a line longer than 90 characters, which will not fit the text box: "${'x'.repeat(40)}..."`,
      'event elder has a command (dance) that is not known; commands are say, choice, if, set, unset, give, take, gold, join, leave, heal, quest, move, face, hide, show, wait, music, sound, shop, inn, battle, warp, ending, event, end',
      'event elder gives golden_goose, which is not in items.json',
      'event elder sets quest wolf to stage halfway, which it does not have',
      'event elder names dragon, who is not in characters.json',
      'event elder checks weather; conditions are flag, not_flag, item, count, gold, member, quest, stage, not_stage',
      'event elder fights kraken, which is not in enemies.json',
      `event elder waits for the flag never_set, but nothing sets it (an event's "set", an NPC's "sets", a battle's "flag" or a chest's "flag")`,
      // the elder no longer sets accepted_quest, so the gate to the forest can never open
      `a warp on meadow waits for the flag accepted_quest, but nothing sets it (an event's "set", an NPC's "sets", a battle's "flag" or a chest's "flag")`,
    ]) expect(problems).toContain(expected)
  })
})

describe('the design document', () => {
  it('merges changes, records decisions, and renders a readable document', () => {
    const project = newGame()
    updateDesign(project, { pillars: ['Short battles', 'Cosy world'], concept: { setting: 'A moonlit valley' } }, { decision: 'Cosy and short', why: 'Little play time' })
    updateDesign(project, { concept: { tone: 'Gentle' }, pillars: ['Short battles'] })
    const design = readDesign(project)
    expect(design.concept).toMatchObject({ setting: 'A moonlit valley', tone: 'Gentle' })
    expect(design.pillars).toEqual(['Short battles'])
    expect(design.decisions).toHaveLength(1)
    const doc = readFileSync(join(project, 'design', 'GAME_DESIGN.md'), 'utf8')
    expect(doc).toContain('**Setting:** A moonlit valley')
    expect(doc).toContain('Cosy and short (Little play time)')
    expect(doc).toContain('- [x] Project: a game that runs')
  })

  it('rejects changes that do not fit', () => {
    const project = newGame()
    expect(() => updateDesign(project, { engine: 'gamemaker' })).toThrow()
  })

  it('merge patch: objects merge, arrays replace, null deletes', () => {
    expect(mergePatch({ a: { b: 1, c: 2 }, d: [1, 2] }, { a: { c: null, e: 3 }, d: [9] })).toEqual({ a: { b: 1, e: 3 }, d: [9] })
  })
})

describe('what is next', () => {
  it('starts at the concept and moves on as phases are marked done', () => {
    const project = newGame()
    let reports = phaseReports(project, readDesign(project))
    expect(currentPhase(reports)?.id).toBe('concept')
    expect(describeNext(readDesign(project), reports)).toContain('Load the skill "game-concept"')
    updateDesign(project, { phases: { concept: { status: 'done' } } })
    reports = phaseReports(project, readDesign(project))
    expect(currentPhase(reports)?.id).toBe('art')
    expect(reports.find(r => r.id === 'art')!.checks.map(c => c.done)).toEqual([false, false, false, false])
  })
})

describe('the design references (loopyhop, with permission)', () => {
  it('search mechanics and styles, add a card, apply a style and hold art to a locked palette', async () => {
    const root = tempDir('studio-refs-')
    const server = createHarnessServer({ projectDir: root, templatesDir: TEMPLATES })
    const client = new Client({ name: 'test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean; structuredContent?: any }
    await call('studio_new_project', { title: 'Moss Knight', pitch: 'A cosy RPG' })

    const groups = (await call('studio_find_mechanic')).content[0]!.text
    expect(groups).toContain('The Gameplay Atlas has 280 mechanics')
    expect(groups).toContain('used with permission')
    const found = await call('studio_find_mechanic', { query: 'enemy telegraphs its next attack' })
    expect(found.structuredContent.ids).toContain('combat-intent-preview')
    const card = (await call('studio_mechanic', { id: 'combat-intent-preview', add: true })).content[0]!.text
    expect(card).toContain('# Previewing enemy intent')
    expect(card).toContain('Playtest question:')
    expect(card).toContain('Added to the design as a mechanic card')
    const design = JSON.parse(readFileSync(join(root, 'moss_knight', 'design', 'game.json'), 'utf8'))
    expect(design.mechanics[0]).toMatchObject({ name: 'Previewing enemy intent', atlasId: 'combat-intent-preview', status: 'idea' })
    expect(readFileSync(join(root, 'moss_knight', 'design', 'GAME_DESIGN.md'), 'utf8')).toContain('### Previewing enemy intent (idea)')
    expect((await call('studio_mechanic', { id: 'combat-intent-preview', add: true })).content[0]!.text).toContain('already in the design')

    expect((await call('studio_art_styles', { query: 'snes pixel' })).structuredContent.ids[0]).toBe('16bit-pixel')
    const applied = (await call('studio_art_style', { id: '16bit-pixel', apply: true })).content[0]!.text
    expect(applied).toContain('Applied')
    const direction = readFileSync(join(root, 'moss_knight', 'design', 'ART_DIRECTION.md'), 'utf8')
    expect(direction).toContain('# Art direction: 16-bit-inspired pixel art')
    expect(direction).toContain('Act as the art director for an original game.')
    expect(direction).toContain('https://store.steampowered.com/app/')
    expect(direction).toContain('used with permission')

    await call('studio_design_update', { patch: { art: { palette: ['#1a1c2c', '#5d275d', '#b13e53', '#ef7d57'], paletteLocked: true } } })
    expect(readFileSync(join(root, 'moss_knight', 'design', 'ART_DIRECTION.md'), 'utf8')).toContain('(locked: use only these colours): #1a1c2c')
    const warned = (await call('studio_paint', { file: 'art/x.png', rows: ['ab'], palette: { a: '#1a1c2c', b: '#ff0000' } })).content[0]!.text
    expect(warned).toContain('Warning: 1 colour(s) are not in the locked palette (#ff0000, nearest #b13e53)')
    const snapped = (await call('studio_paint', { file: 'art/x.png', rows: ['ab'], palette: { a: '#1a1c2c', b: '#ff0000' }, snapToPalette: true })).content[0]!.text
    expect(snapped).toContain('Snapped 1 colour(s) to the locked palette: #ff0000 -> #b13e53')
    const check = (await call('studio_check', { quick: true })).content[0]!.text
    expect(check).toMatch(/· Palette: pictures with colours outside the locked palette[\s\S]*art\/tiles\.png/)
  })
})

describe('studio tools', () => {
  it('start a game and report what is next, without Godot installed', async () => {
    const root = tempDir('studio-mcp-')
    const noGodot: SetupEnv = { platform: 'linux', env: {}, home: '/nowhere', run: () => ({ status: 1, stdout: '', stderr: '' }), exists: () => false, readDir: () => [],
      readFile: () => '', writeFile: () => {}, copyFile: () => {}, reachable: async () => false }
    const server = createHarnessServer({ projectDir: root, setup: noGodot, templatesDir: TEMPLATES })
    const client = new Client({ name: 'test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
    const created = await call('studio_new_project', { title: 'Star Field', pitch: 'Space RPG' })
    expect(created.content[0]!.text).toContain('Godot is not installed yet: run studio_install_godot')
    expect(existsSync(join(root, 'star_field', 'design', 'game.json'))).toBe(true)
    expect((await call('studio_next')).content[0]!.text).toContain('Now: Concept: what the game is')
    expect((await call('studio_design_update', { patch: { pitch: 'Space RPG with cats' }, decision: 'Cats' })).isError).toBeFalsy()
    expect((await call('studio_design_read', { section: 'pitch' })).content[0]!.text).toBe('"Space RPG with cats"')
    const check = await call('studio_check')
    expect(check.content[0]!.text).toContain('✓ Data: every reference between the data files resolves')
    expect(check.content[0]!.text).toContain('Godot is not installed')
    expect((await call('studio_simulate_battle')).content[0]!.text).toContain('studio_install_godot')

    const painted = await call('studio_paint', { file: 'art/enemies.png', rows: ['.rr.', 'rkkr', 'rrrr'], palette: { r: '#d63c3c', k: '#181425' }, at: [6, 0], frame: [32, 32] })
    expect(painted.isError).toBeFalsy()
    expect(painted.content[0]!.text).toContain('the sheet is 224x32, grown to fit')
    expect(readPng(readFileSync(join(root, 'star_field', 'art', 'enemies.png'))).width).toBe(224)
    expect((await call('studio_paint', { file: '../outside.png', rows: ['a'], palette: { a: '#fff' } })).isError).toBe(true)
    expect((await call('studio_music', { file: 'boss', tempo: 150, voices: [{ notes: 'A3 C4 E4:2' }, { notes: 'A2:4', wave: 'triangle' }] })).content[0]!.text).toContain('audio/boss.wav')
    expect(readWav(readFileSync(join(root, 'star_field', 'audio', 'boss.wav'))).channels).toBe(1)
    expect((await call('studio_sound', { name: 'fire', preset: 'fire' })).isError).toBeFalsy()
    expect((await call('studio_sound', { name: 'x', preset: 'nope' })).content[0]!.text).toContain('no sound preset')
  })
})

describe('making art and sound', () => {
  it('paints a text grid into one frame of a sheet and keeps the rest', () => {
    const project = newGame()
    const before = decodePngRgba(readFileSync(join(project, 'art', 'tiles.png')))
    const done = paint(project, { file: 'art/tiles.png', rows: ['ab', 'ba'], palette: { a: '#ff0000', b: 'transparent' }, at: [1, 0], frame: [16, 16] })
    expect(done).toMatchObject({ x: 16, y: 0, width: before.width, grew: false, colors: 1 })
    const after = decodePngRgba(readFileSync(join(project, 'art', 'tiles.png')))
    expect([...after.rgba.subarray(16 * 4, 16 * 4 + 4)]).toEqual([255, 0, 0, 255])
    expect(after.rgba[(16 + 1) * 4 + 3]).toBe(0)                                  // 'b' is transparent, and the old tile is cleared
    expect([...after.rgba.subarray(0, 4)]).toEqual([...before.rgba.subarray(0, 4)]) // frame 0 untouched
    expect(() => paint(project, { file: 'art/x.png', rows: ['az'], palette: { a: '#000' } })).toThrow(/no colour for: "z"/)
    const shown = preview(project, 'art/tiles.png', { scale: 4, frame: [16, 16] })
    expect(readPng(readFileSync(shown.path))).toMatchObject({ width: before.width * 4, height: 64 })
  })

  it('writes notes as music and sound', () => {
    expect(noteFrequency('A4')).toBe(440)
    expect(Math.round(noteFrequency('C4'))).toBe(262)
    expect(Math.round(noteFrequency('F#3'))).toBe(185)
    expect(parseNotes('C4 R:2 G4:0.5')).toEqual([[noteFrequency('C4'), 1], [0, 2], [noteFrequency('G4'), 0.5]])
    expect(() => parseNotes('H4')).toThrow(/not a note/)
    const made = compose([{ notes: 'C4 E4 G4 C5' }, { notes: 'C2:4', wave: 'noise' }], 120, { repeat: 2 })
    expect(made.seconds).toBeCloseTo(4, 1)
    expect(readWav(made.wav).seconds).toBeCloseTo(4, 1)
    expect(readWav(sound('levelup')).seconds).toBeGreaterThan(0.3)
  })
})
