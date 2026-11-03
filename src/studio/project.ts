/**
 * Game projects: creating one from a template (a Godot 4 RPG that runs from minute one), finding the one a session is
 * in, and checking its data without Godot. The project's AGENTS.md makes every new session start where the last ended.
 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { starterArt } from './art.ts'
import { GameDesign, PHASE_TITLES, writeDesign, type GameDesign as Design } from './design.ts'

export const TEMPLATES = ['godot-rpg'] as const

/** templates/ in a checkout, or beside the bundle in the app's payload. */
export function defaultTemplatesDir(here: string): string {
  for (const candidate of [join(here, 'templates'), join(here, '..', '..', 'templates')]) if (existsSync(join(candidate, 'godot-rpg'))) return resolve(candidate)
  return resolve(here, '..', '..', 'templates')
}

export const slugOf = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'my_game'

/** The game project for a folder: the folder itself, or the one subfolder (two levels deep at most) with a design. */
export function findStudioProject(root: string): string | undefined {
  if (existsSync(join(root, 'design', 'game.json'))) return root
  const found: string[] = []
  const look = (dir: string, depth: number) => {
    let names: string[] = []
    try { names = readdirSync(dir) } catch { return }
    for (const name of names) {
      if (name.startsWith('.') || name === 'node_modules') continue
      const path = join(dir, name)
      try { if (!statSync(path).isDirectory()) continue } catch { continue }
      if (existsSync(join(path, 'design', 'game.json'))) found.push(path)
      else if (depth < 2) look(path, depth + 1)
    }
  }
  look(root, 1)
  return found.length === 1 ? found[0] : undefined
}

export interface NewProjectOptions {
  title: string
  pitch?: string
  folder: string
  template?: typeof TEMPLATES[number]
  resolution?: [number, number]
  /** Design decisions already made in the interview; merged over the defaults. */
  design?: Record<string, unknown>
}

const sha = (buffer: Buffer | string) => createHash('sha256').update(buffer).digest('hex')

/** Creates a game from a template; answers the project folder and what was made. */
export function createProject(templatesDir: string, options: NewProjectOptions): { project: string; files: number } {
  const template = options.template ?? 'godot-rpg'
  const source = join(templatesDir, template)
  if (!existsSync(source)) throw new Error(`no template ${template} in ${templatesDir}`)
  const project = resolve(options.folder)
  if (existsSync(project) && readdirSync(project).some(name => !name.startsWith('.'))) {
    if (existsSync(join(project, 'design', 'game.json'))) throw new Error(`${project} already has a game; continue it instead`)
    throw new Error(`${project} is not empty; choose a new folder for the game`)
  }
  mkdirSync(project, { recursive: true })
  cpSync(source, project, { recursive: true })
  const [width, height] = options.resolution ?? [320, 180]
  const scale = Math.max(1, Math.min(Math.floor(1280 / width), Math.floor(720 / height)))
  const values: Record<string, string> = {
    TITLE: options.title.replace(/"/g, "'"), PITCH: (options.pitch ?? '').replace(/"/g, "'"), SLUG: slugOf(options.title),
    WIDTH: String(width), HEIGHT: String(height), WINDOW_WIDTH: String(width * scale), WINDOW_HEIGHT: String(height * scale),
  }
  let files = 0
  const fill = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) { fill(path); continue }
      files++
      if (!/\.(godot|json|gd|tscn|cfg|md|txt)$/.test(name)) continue
      const text = readFileSync(path, 'utf8')
      if (text.includes('{{')) writeFileSync(path, text.replace(/\{\{(\w+)\}\}/g, (all, key: string) => values[key] ?? all))
    }
  }
  fill(project)
  const placeholders: Record<string, string> = {}
  for (const [path, buffer] of Object.entries(starterArt())) {
    mkdirSync(dirname(join(project, path)), { recursive: true })
    writeFileSync(join(project, path), buffer)
    placeholders[path] = sha(buffer)
    files++
  }
  mkdirSync(join(project, '.studio'), { recursive: true })
  writeFileSync(join(project, '.studio', 'placeholders.json'), `${JSON.stringify(placeholders, null, 2)}\n`)
  writeFileSync(join(project, '.gitignore'), '.godot/\nbuilds/\n.studio/cache/\n*.tmp\n')
  const design = GameDesign.parse({
    title: options.title, pitch: options.pitch ?? '', template, engine: 'godot', genre: '2D RPG',
    art: { resolution: [width, height], tileSize: 16 },
    ...(options.design ?? {}),
    phases: { ...(options.design?.phases as object ?? {}), project: { status: 'done', notes: `Created from the ${template} template` } },
  })
  writeDesign(project, design)
  writeFileSync(join(project, 'AGENTS.md'), agentsMd(design))
  return { project, files }
}

/** The project's standing instructions, loaded by the agent at the start of every session in this folder. */
export function agentsMd(design: Design): string {
  return `# ${design.title}: working on this game

This is a game made with Engine Harness (Godot 4, ${design.genre}). The developer may be new to making games: explain
choices in plain words, ask one question at a time, and keep every step small enough to play right away.

At the start of every session:
1. Run studio_next. It reads design/GAME_DESIGN.md, checks the project, and says which phase is in progress and the
   next concrete step. Load the skill it names before working on that phase.
2. Greet the developer with where the game stands in two lines and propose that next step.

Rules:
- design/game.json is the memory of what was decided. Record every decision with studio_design_update (with a short
  "why"), and mark a phase done there only when the developer agrees it is done.
- The game's numbers and content are data: data/*.json, maps/*.txt, maps/maps.json. Change them there; read README.md
  for where everything lives.
- After changing scripts or data, run studio_check. After changing battle numbers, run studio_simulate_battle.
- To let the developer try something, run the game with godot_run (window: true) and say exactly what to try.
- Never delete the developer's files or overwrite art and audio they made without asking.

Phases: ${Object.values(PHASE_TITLES).join(' → ')}.
`
}

// ---- placeholders ---------------------------------------------------------------------------------------------------

/** Art and audio files still exactly as generated: the art and audio phases replace them. */
export function placeholdersLeft(project: string): string[] {
  const path = join(project, '.studio', 'placeholders.json')
  if (!existsSync(path)) return []
  const recorded = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
  return Object.entries(recorded).filter(([file, hash]) => existsSync(join(project, file)) && sha(readFileSync(join(project, file))) === hash).map(([file]) => file)
}

// ---- data checks (no Godot needed) ----------------------------------------------------------------------------------

const readJson = (project: string, path: string): Record<string, any> => {
  const full = join(project, path)
  if (!existsSync(full)) throw new Error(`${path} is missing`)
  try {
    return JSON.parse(readFileSync(full, 'utf8'))
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`)
  }
}

export interface ProjectData {
  characters: Record<string, any>; enemies: Record<string, any>; skills: Record<string, any>; items: Record<string, any>
  encounters: Record<string, any>; dialogue: Record<string, any>; formulas: Record<string, any>; party: Record<string, any>
  maps: Record<string, any>; legend: Record<string, any>; game: Record<string, any>
}

export function readProjectData(project: string): ProjectData {
  return {
    characters: readJson(project, 'data/characters.json'), enemies: readJson(project, 'data/enemies.json'),
    skills: readJson(project, 'data/skills.json'), items: readJson(project, 'data/items.json'),
    encounters: readJson(project, 'data/encounters.json'), dialogue: readJson(project, 'data/dialogue.json'),
    formulas: readJson(project, 'data/formulas.json'), party: readJson(project, 'data/party.json'),
    maps: readJson(project, 'maps/maps.json'), legend: readJson(project, 'maps/legend.json'), game: readJson(project, 'data/game.json'),
  }
}

export function mapRows(project: string, maps: Record<string, any>, id: string): string[] {
  const file = join(project, 'maps', maps[id]?.file ?? `${id}.txt`)
  if (!existsSync(file)) return []
  const rows = readFileSync(file, 'utf8').replace(/\r/g, '').split('\n')
  while (rows.length && !rows.at(-1)!.trim()) rows.pop()
  return rows
}

/**
 * Every reference between the data files, in plain words, the same checks as the game's tools/self_test.gd; runs
 * without Godot, so it works before Godot is installed.
 */
export function checkProjectData(project: string): string[] {
  const problems: string[] = []
  let d: ProjectData
  try {
    d = readProjectData(project)
  } catch (error) {
    return [(error as Error).message]
  }
  const has = (table: Record<string, any>, id: string) => Object.prototype.hasOwnProperty.call(table, id)
  for (const id of d.party.members ?? []) if (!has(d.characters, id)) problems.push(`party.json starts with ${id}, which is not in characters.json`)
  for (const [id, c] of Object.entries(d.characters)) {
    for (const skill of [...(c.skills ?? []), ...Object.values(c.learns ?? {})] as string[]) if (!has(d.skills, skill)) problems.push(`character ${id} knows skill ${skill}, which is not in skills.json`)
    for (const stat of ['hp', 'mp', 'atk', 'def', 'mag', 'spd']) if (typeof c.base?.[stat] !== 'number') problems.push(`character ${id} has no base ${stat}`)
  }
  for (const [id, e] of Object.entries(d.enemies)) {
    for (const skill of e.skills ?? []) if (!has(d.skills, skill)) problems.push(`enemy ${id} uses skill ${skill}, which is not in skills.json`)
    if (e.drop?.item && !has(d.items, e.drop.item)) problems.push(`enemy ${id} drops ${e.drop.item}, which is not in items.json`)
    for (const stat of ['hp', 'atk', 'def', 'spd']) if (typeof e.stats?.[stat] !== 'number') problems.push(`enemy ${id} has no ${stat}`)
    const frames = Number(d.game.enemy_frames ?? 0)
    if (frames && (typeof e.frame !== 'number' || e.frame < 0 || e.frame >= frames)) problems.push(`enemy ${id} uses picture ${e.frame} but art/enemies.png has frames 0 to ${frames - 1} (enemy_frames in game.json)`)
  }
  for (const [id, skill] of Object.entries(d.skills)) if (!['physical', 'magic', 'heal'].includes(skill.type)) problems.push(`skill ${id} has type ${skill.type}; the battle system knows physical, magic and heal`)
  for (const [id, item] of Object.entries(d.items)) if (!['heal', 'mp'].includes(item.effect)) problems.push(`item ${id} has effect ${item.effect}; items can heal or mp`)
  for (const [zone, info] of Object.entries(d.encounters)) for (const group of info.groups ?? []) for (const enemy of group) if (!has(d.enemies, enemy)) problems.push(`encounter zone ${zone} has enemy ${enemy}, which is not in enemies.json`)
  for (const item of Object.keys(d.party.items ?? {})) if (!has(d.items, item)) problems.push(`party.json starts with item ${item}, which is not in items.json`)
  for (const name of ['physical', 'magic', 'heal', 'xp_to_next', 'run_chance']) if (typeof d.formulas[name] !== 'string') problems.push(`formulas.json has no ${name} formula`)
  const solid = (rows: string[], x: number, y: number) => y < 0 || y >= rows.length || x < 0 || x >= (rows[y]?.length ?? 0) || !!d.legend[rows[y]![x]!]?.solid
  if (!has(d.maps, d.party.map)) problems.push(`party.json starts on map ${d.party.map}, which is not in maps.json`)
  else if (solid(mapRows(project, d.maps, d.party.map), d.party.position?.[0], d.party.position?.[1])) problems.push('the party starts on a solid tile')
  for (const [id, info] of Object.entries(d.maps)) {
    const rows = mapRows(project, d.maps, id)
    if (!rows.length) { problems.push(`map ${id} has no file maps/${info.file ?? `${id}.txt`}`); continue }
    const unknown = new Set<string>()
    rows.forEach(row => [...row].forEach(ch => { if (!has(d.legend, ch)) unknown.add(ch) }))
    for (const ch of unknown) problems.push(`map ${id} uses '${ch}', which is not in legend.json`)
    const widths = new Set(rows.map(row => [...row].length))
    if (widths.size > 1) problems.push(`map ${id} has rows of different lengths (${[...widths].join(', ')}); every row needs the same number of characters`)
    if (typeof info.music === 'string' && info.music.startsWith('res://') && !existsSync(join(project, info.music.slice(6)))) problems.push(`map ${id} plays ${info.music}, which does not exist`)
    if (info.encounters && !has(d.encounters, info.encounters)) problems.push(`map ${id} uses encounter zone ${info.encounters}, which is not in encounters.json`)
    for (const npc of info.npcs ?? []) {
      if (npc.role !== 'chest' && !has(d.dialogue, npc.dialogue ?? '')) problems.push(`NPC ${npc.id} on ${id} says ${npc.dialogue}, which is not in dialogue.json`)
      if (solid(rows, npc.x, npc.y)) problems.push(`NPC ${npc.id} on ${id} stands on a solid tile at ${npc.x},${npc.y}`)
      const frames = Number(d.game.npc_frames ?? 0)
      if (frames && (npc.frame ?? 0) >= frames) problems.push(`NPC ${npc.id} on ${id} uses picture ${npc.frame} but art/npcs.png has frames 0 to ${frames - 1} (npc_frames in game.json)`)
      for (const item of npc.stock ?? []) if (!has(d.items, item)) problems.push(`shop ${npc.id} on ${id} sells ${item}, which is not in items.json`)
      if (npc.role === 'battle') {
        if (!npc.enemies?.length) problems.push(`NPC ${npc.id} on ${id} starts a battle but lists no enemies`)
        for (const enemy of npc.enemies ?? []) if (!has(d.enemies, enemy)) problems.push(`NPC ${npc.id} on ${id} fights ${enemy}, which is not in enemies.json`)
        if (npc.ending && !has(d.dialogue, 'ending')) problems.push(`NPC ${npc.id} on ${id} ends the game, but dialogue.json has no "ending" lines`)
      }
      if (npc.role === 'chest' && npc.item && !has(d.items, npc.item)) problems.push(`chest ${npc.id} on ${id} holds ${npc.item}, which is not in items.json`)
      if (npc.role === 'chest' && !npc.item && !npc.gold) problems.push(`chest ${npc.id} on ${id} holds nothing; give it an item or gold`)
      for (const key of [npc.after, ...Object.values(npc.dialogue_after ?? {})]) if (key && !has(d.dialogue, key)) problems.push(`NPC ${npc.id} on ${id} uses dialogue ${key}, which is not in dialogue.json`)
    }
    for (const warp of info.warps ?? []) {
      if (warp.locked && !has(d.dialogue, warp.locked)) problems.push(`a warp on ${id} says ${warp.locked} when shut, which is not in dialogue.json`)
      if (!has(d.maps, warp.to)) problems.push(`a warp on ${id} leads to map ${warp.to}, which is not in maps.json`)
      else if (solid(mapRows(project, d.maps, warp.to), warp.to_x, warp.to_y)) problems.push(`a warp on ${id} lands on a solid tile of ${warp.to}`)
      else if ((d.maps[warp.to].warps ?? []).some((w: any) => w.x === warp.to_x && w.y === warp.to_y)) problems.push(`a warp on ${id} lands on another warp in ${warp.to} at ${warp.to_x},${warp.to_y}, so the player would bounce; land one step away from it`)
    }
  }
  // Story flags: every flag something waits for has to be set by something, or that door never opens.
  const setFlags = new Set<string>()
  const wanted: [string, string][] = []
  for (const [id, info] of Object.entries(d.maps)) {
    for (const npc of info.npcs ?? []) {
      if (npc.sets) setFlags.add(npc.sets)
      if (npc.role === 'battle') setFlags.add(npc.flag ?? `beat_${npc.id}`)
      if (npc.role === 'chest') setFlags.add(npc.flag ?? `chest_${id}_${npc.id}`)
      for (const flag of [npc.only_if, npc.hide_if, ...Object.keys(npc.dialogue_after ?? {})]) if (flag) wanted.push([flag, `NPC ${npc.id} on ${id}`])
    }
    for (const warp of info.warps ?? []) if (warp.requires) wanted.push([warp.requires, `a warp on ${id}`])
  }
  for (const [flag, who] of wanted) if (!setFlags.has(flag)) problems.push(`${who} waits for the flag ${flag}, but nothing sets it (an NPC's "sets", a battle's "flag" or a chest's "flag")`)
  for (const [key, path] of Object.entries(d.game)) {
    if (typeof path === 'string' && path.startsWith('res://') && /\.(png|wav|ogg)$/.test(path) && !existsSync(join(project, path.slice(6)))) {
      if (!/\.(wav|ogg)$/.test(path)) problems.push(`game.json ${key} points to ${path}, which does not exist`)
    }
  }
  return problems
}

export const rel = (project: string, path: string) => relative(project, path).split(sep).join('/')
