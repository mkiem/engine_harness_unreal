/**
 * The path from idea to a game you can share, as phases. Each has a goal in plain words, the skill that guides it, and
 * checks against the real project, so "what's next" is answered from the files, not from memory.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PHASE_IDS, PHASE_TITLES, type GameDesign, type PhaseId } from './design.ts'
import { checkProjectData, placeholdersLeft, readProjectData } from './project.ts'

export interface Check { done: boolean; text: string }
export interface PhaseReport { id: PhaseId; title: string; goal: string; skill: string; status: 'todo' | 'doing' | 'done'; checks: Check[]; next: string }

interface Phase { goal: string; skill: string; next: string; checks: (project: string, design: GameDesign) => Check[] }

const check = (done: boolean, text: string): Check => ({ done, text })

export function balanceResults(project: string): Record<string, { win_rate: number; avg_turns: number; avg_hp_left: number; level: number; enemies: string[] }> {
  const path = join(project, '.studio', 'balance.json')
  if (!existsSync(path)) return {}
  try { return JSON.parse(readFileSync(path, 'utf8')).results ?? {} } catch { return {} }
}

/** Every distinct enemy group the player can meet: the encounter zones' groups, then story battles (bosses). */
export function battleGroups(project: string): string[][] {
  let groups: string[][] = []
  try {
    const data = readProjectData(project)
    groups = [
      ...Object.values(data.encounters).flatMap((zone: any) => zone.groups ?? []),
      ...Object.values(data.maps).flatMap((m: any) => m.npcs ?? []).filter((n: any) => n.role === 'battle' && n.enemies?.length).map((n: any) => n.enemies),
    ]
  } catch { /* reported by the data checks */ }
  return [...new Map(groups.map(group => [group.join('+'), group] as const)).values()]
}

const PHASES: Record<PhaseId, Phase> = {
  concept: {
    goal: 'Decide what the game is: the kind of game, the feeling, the core loop, the setting, and a first playable goal small enough to finish.',
    skill: 'game-concept',
    next: 'Interview the developer one question at a time (kind of game, games it should feel like, setting, tone, core loop), then propose a pitch, three pillars and a first playable goal, and record them with studio_design_update.',
    checks: (_p, d) => [
      check(!!d.pitch.trim(), 'A one-sentence pitch'),
      check(d.inspirations.length > 0, 'Games it should feel like'),
      check(d.pillars.length >= 2, 'Two or three design pillars'),
      check(!!d.concept.coreLoop.trim(), 'The core loop (what the player does over and over)'),
      check(!!d.concept.setting.trim() && !!d.concept.tone.trim(), 'Setting and tone'),
      check(!!d.scope.firstPlayable.trim(), 'A first playable goal'),
    ],
  },
  project: {
    goal: 'A game project that runs: title screen, a map to walk, a battle, saving.',
    skill: 'godot-rpg-template',
    next: 'Create the project with studio_new_project, run studio_check, then open it with godot_run (window: true) so the developer can walk around and fight once.',
    checks: (p) => [
      check(existsSync(join(p, 'project.godot')), 'The Godot project exists'),
      check(checkProjectData(p).length === 0, 'Its data checks pass (studio_check)'),
    ],
  },
  art: {
    goal: 'A look for the game: resolution, palette and style, then the hero, tiles and monsters drawn in it.',
    skill: 'art-direction',
    next: 'Agree the palette and style with the developer and record them; then replace the placeholder art one file at a time (tiles, hero, NPCs, enemies), checking each in the running game.',
    checks: (p, d) => {
      const left = placeholdersLeft(p).filter(file => file.startsWith('art/'))
      return [
        check(!!d.art.style.trim(), 'An art style in words'),
        check(d.art.palette.length >= 4, 'A palette of at least four colours'),
        check(left.length === 0, left.length ? `Placeholder art still in use: ${left.join(', ')}` : 'All placeholder art replaced'),
      ]
    },
  },
  characters: {
    goal: 'The heroes and the main people of the world: who they are, how they look, how they fight.',
    skill: 'character-design',
    next: 'Design the party with the developer (name, role, personality, look, abilities), record them in the design, then put their stats and skills in data/characters.json and their sprites in art/.',
    checks: (p, d) => {
      let ids: string[] = []
      try { ids = Object.keys(readProjectData(p).characters) } catch { /* reported by the project phase */ }
      const playable = d.characters.filter(c => c.playable)
      return [
        check(playable.length >= 1, 'At least one playable character in the design'),
        check(playable.length > 0 && playable.every(c => ids.includes(c.id)), 'Every playable character exists in data/characters.json'),
        check(playable.every(c => !!c.look.trim() && !!c.role.trim()), 'Each has a role and a look'),
      ]
    },
  },
  world: {
    goal: 'The places of the game: regions, their maps, who lives there, and how they connect.',
    skill: 'world-building',
    next: 'Sketch the regions with the developer, then build each map as a text grid in maps/, add it to maps/maps.json with its NPCs, warps, music and encounter zone, and walk it in the game.',
    checks: (p, d) => {
      let maps: string[] = []
      try { maps = Object.keys(readProjectData(p).maps) } catch { /* reported elsewhere */ }
      return [
        check(d.world.regions.length >= 2, 'At least two regions in the design'),
        check(maps.length >= 3, `At least three maps (${maps.length} now)`),
        check(d.world.regions.every(r => !r.map || maps.includes(r.map)), 'Every region with a map points to a real map'),
      ]
    },
  },
  battle: {
    goal: 'How fights work and feel: commands, skills, enemies, and how hard each area is.',
    skill: 'battle-design',
    next: 'Agree how battles should feel, design enemies for each area in data/enemies.json and data/encounters.json, then run studio_simulate_battle on each encounter group.',
    checks: (p, d) => {
      let enemies = 0
      try { enemies = Object.keys(readProjectData(p).enemies).length } catch { /* reported elsewhere */ }
      return [
        check(!!d.systems.battle.trim(), 'The battle rules described in the design'),
        check(enemies >= 4, `At least four kinds of enemy (${enemies} now)`),
        check(Object.keys(balanceResults(p)).length > 0, 'At least one battle simulated'),
      ]
    },
  },
  items: {
    goal: 'What the player collects and buys, what it costs, and how the party gets stronger.',
    skill: 'items-and-economy',
    next: 'Design items and prices with the developer in data/items.json, put shops on the maps, and check that a few battles pay for a potion.',
    checks: (p) => {
      let items = 0
      let shops = 0
      try {
        const data = readProjectData(p)
        items = Object.keys(data.items).length
        shops = Object.values(data.maps).flatMap((m: any) => m.npcs ?? []).filter((n: any) => n.role === 'shop').length
      } catch { /* reported elsewhere */ }
      return [check(items >= 3, `At least three items (${items} now)`), check(shops >= 1, 'At least one shop')]
    },
  },
  story: {
    goal: 'The story from start to end, and what everyone says along the way.',
    skill: 'story-and-dialogue',
    next: 'Write the premise and the story beats with the developer, then the dialogue for every NPC in data/dialogue.json, and play through to read it in the game.',
    checks: (p, d) => {
      let npcs: any[] = []
      try { npcs = Object.values(readProjectData(p).maps).flatMap((m: any) => m.npcs ?? []) } catch { /* reported elsewhere */ }
      return [
        check(!!d.concept.story.premise.trim(), 'A story premise'),
        check(d.concept.story.beats.length >= 3, 'At least three story beats'),
        check(!!d.concept.story.ending.trim(), 'An ending for the first playable'),
        check(npcs.some(n => n.role === 'battle' && n.ending), 'The game can be finished (a battle NPC with "ending": true)'),
      ]
    },
  },
  ui: {
    goal: 'The title screen, menus and battle screen look like this game and are easy to use.',
    skill: 'ui-and-menus',
    next: 'Set the title and tagline in data/game.json, choose UI colours from the palette, and walk the developer through the title, pause menu and battle screen.',
    checks: (p, d) => {
      let game: Record<string, any> = {}
      try { game = readProjectData(p).game } catch { /* reported elsewhere */ }
      return [check(game.title === d.title, 'The title screen shows the game\'s title'), check(!!String(game.tagline ?? '').trim(), 'A tagline on the title screen')]
    },
  },
  audio: {
    goal: 'Music for each place and sounds for every action, in the game\'s mood.',
    skill: 'audio-and-music',
    next: 'Agree the musical mood, then replace the placeholder music and sounds in audio/ (made with reproducible scripts or openly licensed packs), checking each in the game.',
    checks: (p, d) => {
      const music = ['title', 'town', 'field', 'battle'].map(name => `audio/${name}.wav`)
      const left = placeholdersLeft(p).filter(file => music.includes(file))
      return [check(!!d.audio.mood.trim(), 'A musical mood in the design'), check(left.length === 0, left.length ? `Placeholder music still in use: ${left.join(', ')}` : 'All placeholder music replaced')]
    },
  },
  balance: {
    goal: 'Every area is as hard as intended, from the first slime to the last boss, and the first playable is fun from start to end.',
    skill: 'playtest-and-balance',
    next: 'Simulate every encounter group at the level the player will be there, fix anything outside the intended range, then have the developer play the first playable start to finish and note what felt wrong.',
    checks: (p) => {
      const groups = battleGroups(p).map(g => g.join('+'))
      const results = balanceResults(p)
      const tested = new Set(Object.values(results).map(r => r.enemies.join('+')))
      const untested = [...new Set(groups)].filter(g => !tested.has(g))
      return [check(groups.length > 0 && untested.length === 0, untested.length ? `Not yet simulated: ${untested.join(', ')}` : 'Every encounter group and boss simulated')]
    },
  },
  build: {
    goal: 'A Windows .exe the developer can send to friends.',
    skill: 'build-and-share',
    next: 'Run studio_export (it installs Godot\'s export templates the first time, with the developer\'s agreement), then have the developer run the .exe from builds/windows.',
    checks: (p) => {
      const dir = join(p, 'builds', 'windows')
      const built = existsSync(dir) && readdirSync(dir).some(name => name.endsWith('.exe'))
      return [check(built, 'A Windows build in builds/windows')]
    },
  },
}

export function phaseReports(project: string, design: GameDesign): PhaseReport[] {
  return PHASE_IDS.map(id => ({
    id, title: PHASE_TITLES[id], goal: PHASES[id].goal, skill: PHASES[id].skill, next: PHASES[id].next,
    status: design.phases[id]?.status ?? 'todo', checks: PHASES[id].checks(project, design),
  }))
}

/** The phase to work on: the first one the developer has not marked done. */
export function currentPhase(reports: PhaseReport[]): PhaseReport | undefined {
  return reports.find(report => report.status !== 'done')
}

export function describeNext(design: GameDesign, reports: PhaseReport[]): string {
  const current = currentPhase(reports)
  const done = reports.filter(report => report.status === 'done').length
  const progress = reports.map(r => `${r.status === 'done' ? '[x]' : r === current ? '[>]' : '[ ]'} ${r.title}`).join('\n')
  if (!current) return `${design.title}: every phase is done (${done}/${reports.length}). Ask the developer what to add next, and record it in the design's scope.\n\n${progress}`
  const open = current.checks.filter(c => !c.done)
  return [
    `${design.title}: ${done}/${reports.length} phases done. Now: ${current.title}.`,
    `Goal: ${current.goal}`,
    `Load the skill "${current.skill}" for how to run this phase.`,
    '',
    'Checklist:',
    ...current.checks.map(c => `${c.done ? '[x]' : '[ ]'} ${c.text}`),
    '',
    open.length ? `Next step: ${current.next}` : 'Every check passes: ask the developer whether this phase is done, and if so mark it done with studio_design_update ({"phases": {"' + current.id + '": {"status": "done"}}}).',
    '',
    'All phases:',
    progress,
  ].join('\n')
}
