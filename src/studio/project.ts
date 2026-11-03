/**
 * Game projects: creating one from a template (a Godot 4 RPG that runs from minute one), finding the one a session is
 * in, and checking its data without Godot. The project's AGENTS.md makes every new session start where the last ended.
 */
import { checkData } from './checks.ts'
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
- Before making any picture, read design/ART_DIRECTION.md when it exists and follow it; with a locked palette, use only
  its colours (studio_paint warns otherwise).
- New ideas for how the game plays become mechanic cards in the design first (studio_find_mechanic, studio_mechanic),
  then a small prototype that answers the card's playtest question.
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
  rules: Record<string, any>; statuses: Record<string, any>; events: Record<string, any>; quests: Record<string, any>
}

const readOptional = (project: string, path: string): Record<string, any> => existsSync(join(project, path)) ? readJson(project, path) : {}

export function readProjectData(project: string): ProjectData {
  return {
    characters: readJson(project, 'data/characters.json'), enemies: readJson(project, 'data/enemies.json'),
    skills: readJson(project, 'data/skills.json'), items: readJson(project, 'data/items.json'),
    encounters: readJson(project, 'data/encounters.json'), dialogue: readJson(project, 'data/dialogue.json'),
    formulas: readJson(project, 'data/formulas.json'), party: readJson(project, 'data/party.json'),
    maps: readJson(project, 'maps/maps.json'), legend: readJson(project, 'maps/legend.json'), game: readJson(project, 'data/game.json'),
    rules: readOptional(project, 'data/rules.json'), statuses: readOptional(project, 'data/statuses.json'),
    events: readOptional(project, 'data/events.json'), quests: readOptional(project, 'data/quests.json'),
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
  let d: ProjectData
  try {
    d = readProjectData(project)
  } catch (error) {
    return [(error as Error).message]
  }
  return checkData(d, (map: string) => mapRows(project, d.maps, map), (path: string) => existsSync(join(project, path)),
    (path: string) => existsSync(join(project, path)) ? readFileSync(join(project, path), 'utf8') : undefined)
}

export const rel = (project: string, path: string) => relative(project, path).split(sep).join('/')
