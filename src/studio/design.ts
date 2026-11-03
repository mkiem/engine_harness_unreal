/**
 * The game design document: the project's memory. design/game.json holds it as data, design/GAME_DESIGN.md is the same
 * thing written out for people, and every session starts by reading it (the project's AGENTS.md says so). Numbers
 * that the game uses (stats, prices, formulas) live in the game's data/ files, not here: this is the why and the what.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'

export const PHASE_IDS = ['concept', 'project', 'art', 'characters', 'world', 'battle', 'items', 'story', 'ui', 'audio', 'balance', 'build'] as const
export type PhaseId = typeof PHASE_IDS[number]

const Character = z.object({
  id: z.string(), name: z.string(), role: z.string().default(''), personality: z.string().default(''),
  look: z.string().default(''), abilities: z.string().default(''), playable: z.boolean().default(true),
}).passthrough()

/**
 * A mechanic card: one loop of player action, constraints and feedback, written before it is built, then prototyped
 * as small as possible and kept or cut by what its playtest question shows. Cards can start from the Gameplay Atlas
 * (atlasId) and are then made the game's own.
 */
export const MechanicCard = z.object({
  name: z.string(),
  atlasId: z.string().optional(),
  summary: z.string().default(''),
  loop: z.array(z.string()).default([]),
  decisions: z.array(z.string()).default([]),
  parameters: z.array(z.object({ name: z.string(), value: z.string().default(''), effect: z.string().default('') }).passthrough()).default([]),
  prototype: z.object({ firstStep: z.string().default(''), pitfall: z.string().default(''), test: z.string().default(''), result: z.string().default('') }).passthrough().default({}),
  status: z.enum(['idea', 'prototyping', 'kept', 'cut']).default('idea'),
  notes: z.string().default(''),
}).passthrough()
export type MechanicCard = z.infer<typeof MechanicCard>

const Region = z.object({ id: z.string(), name: z.string(), description: z.string().default(''), map: z.string().optional(), mood: z.string().default('') }).passthrough()

export const GameDesign = z.object({
  version: z.literal(1).default(1),
  title: z.string(),
  pitch: z.string().default(''),
  genre: z.string().default('2D RPG'),
  engine: z.enum(['godot', 'unreal']).default('godot'),
  template: z.string().default('godot-rpg'),
  /** Games the developer wants it to feel like. */
  inspirations: z.array(z.string()).default([]),
  audience: z.string().default(''),
  /** Three or so short rules every decision is checked against, such as "every battle is over in a minute". */
  pillars: z.array(z.string()).default([]),
  concept: z.object({
    coreLoop: z.string().default(''),
    setting: z.string().default(''),
    tone: z.string().default(''),
    story: z.object({ premise: z.string().default(''), beats: z.array(z.string()).default([]), ending: z.string().default('') }).passthrough().default({}),
  }).passthrough().default({}),
  art: z.object({
    resolution: z.tuple([z.number().int(), z.number().int()]).default([320, 180]),
    tileSize: z.number().int().default(16),
    palette: z.array(z.string()).default([]),
    style: z.string().default(''),
    references: z.array(z.string()).default([]),
    /** The Game Art Style entry the look starts from, when one was chosen. */
    styleId: z.string().default(''),
    /** Three or so visual cues every picture in the game should show. */
    lookFor: z.array(z.string()).default([]),
    /** The art bible's rules by subject: outline, shading, proportions, lighting, ui, motion, effects... */
    rules: z.record(z.string(), z.string()).default({}),
    /** Visual mistakes to avoid. */
    avoid: z.array(z.string()).default([]),
    /** When true, studio_paint and studio_check hold every picture to the palette. */
    paletteLocked: z.boolean().default(false),
  }).passthrough().default({}),
  characters: z.array(Character).default([]),
  mechanics: z.array(MechanicCard).default([]),
  world: z.object({ regions: z.array(Region).default([]) }).passthrough().default({}),
  systems: z.object({
    battle: z.string().default('Turn-based: the fastest acts first; Attack, Skill, Item, Defend, Run.'),
    progression: z.string().default('XP from battles raises levels; stats grow per level; new skills at set levels.'),
    economy: z.string().default('Gold from battles buys items in shops; the inn heals for free.'),
  }).passthrough().default({}),
  audio: z.object({ mood: z.string().default(''), tracks: z.array(z.string()).default([]) }).passthrough().default({}),
  /** The first playable goal: small enough to finish, so the game is fun before it is big. */
  scope: z.object({ firstPlayable: z.string().default(''), later: z.array(z.string()).default([]) }).passthrough().default({}),
  decisions: z.array(z.object({ date: z.string(), decision: z.string(), why: z.string().default('') })).default([]),
  phases: z.record(z.string(), z.object({ status: z.enum(['todo', 'doing', 'done']).default('todo'), notes: z.string().default('') })).default({}),
}).passthrough()
export type GameDesign = z.infer<typeof GameDesign>

export const designPath = (project: string) => join(project, 'design', 'game.json')
export const designDocPath = (project: string) => join(project, 'design', 'GAME_DESIGN.md')

export function readDesign(project: string): GameDesign {
  const path = designPath(project)
  if (!existsSync(path)) throw new Error(`no design at ${path}; start a game with studio_new_project`)
  return GameDesign.parse(JSON.parse(readFileSync(path, 'utf8')))
}

export function writeDesign(project: string, design: GameDesign): void {
  mkdirSync(dirname(designPath(project)), { recursive: true })
  writeFileSync(designPath(project), `${JSON.stringify(design, null, 2)}\n`)
  writeFileSync(designDocPath(project), renderDesign(design))
}

/**
 * Applies a JSON merge patch (RFC 7386: objects merge, arrays and values replace, null deletes) and records a decision
 * when one is given. Answers the new design, checked against the schema.
 */
export function updateDesign(project: string, patch: Record<string, unknown>, decision?: { decision: string; why?: string }): GameDesign {
  const current = readDesign(project) as Record<string, unknown>
  const merged = GameDesign.parse(mergePatch(current, patch))
  if (decision?.decision) merged.decisions.push({ date: new Date().toISOString().slice(0, 10), decision: decision.decision, why: decision.why ?? '' })
  writeDesign(project, merged)
  return merged
}

export function mergePatch(target: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const out: Record<string, unknown> = target && typeof target === 'object' && !Array.isArray(target) ? { ...(target as Record<string, unknown>) } : {}
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === null) delete out[key]
    else out[key] = mergePatch(out[key], value)
  }
  return out
}

const list = (items: string[]) => items.length ? items.map(item => `- ${item}`).join('\n') : '_Not decided yet._'
const or = (text: string) => text.trim() || '_Not decided yet._'

/** The design as a document a person reads: plain headings, no JSON. */
export function renderDesign(d: GameDesign): string {
  const phaseLine = (id: string) => `- ${d.phases[id]?.status === 'done' ? '[x]' : d.phases[id]?.status === 'doing' ? '[~]' : '[ ]'} ${PHASE_TITLES[id as PhaseId] ?? id}${d.phases[id]?.notes ? `: ${d.phases[id]!.notes}` : ''}`
  return [
    `# ${d.title}`,
    '',
    `> ${or(d.pitch)}`,
    '',
    `**Genre:** ${d.genre} · **Engine:** ${d.engine === 'godot' ? 'Godot 4' : 'Unreal Engine 5'}${d.audience ? ` · **For:** ${d.audience}` : ''}`,
    d.inspirations.length ? `**Feels like:** ${d.inspirations.join(', ')}` : '',
    '',
    '## Pillars', '', list(d.pillars), '',
    '## Concept', '',
    `**Core loop:** ${or(d.concept.coreLoop)}`, '',
    `**Setting:** ${or(d.concept.setting)}`, '',
    `**Tone:** ${or(d.concept.tone)}`, '',
    '## Story', '',
    `**Premise:** ${or(d.concept.story.premise)}`, '',
    d.concept.story.beats.length ? `**Beats:**\n\n${d.concept.story.beats.map((beat, i) => `${i + 1}. ${beat}`).join('\n')}\n` : '',
    d.concept.story.ending ? `**Ending:** ${d.concept.story.ending}\n` : '',
    '## Art direction', '',
    `**Resolution:** ${d.art.resolution[0]}x${d.art.resolution[1]}, ${d.art.tileSize}x${d.art.tileSize} tiles`, '',
    `**Style:** ${or(d.art.style)}`, '',
    d.art.palette.length ? `**Palette${d.art.paletteLocked ? ' (locked)' : ''}:** ${d.art.palette.map(color => `\`${color}\``).join(' ')}\n` : '',
    d.art.lookFor.length ? `**In every picture:**\n\n${list(d.art.lookFor)}\n` : '',
    Object.keys(d.art.rules).length ? `**Rules:**\n\n${Object.entries(d.art.rules).map(([k, v]) => `- ${k}: ${v}`).join('\n')}\n` : '',
    d.art.avoid.length ? `**Avoid:**\n\n${list(d.art.avoid)}\n` : '',
    d.art.styleId ? `_The full art direction is in design/ART_DIRECTION.md._\n` : '',
    d.art.references.length ? `**References:**\n\n${list(d.art.references)}\n` : '',
    '## Characters', '',
    d.characters.length ? d.characters.map(c => `### ${c.name}${c.playable ? '' : ' (NPC)'}\n\n${[c.role && `**Role:** ${c.role}`, c.personality && `**Personality:** ${c.personality}`, c.look && `**Look:** ${c.look}`, c.abilities && `**Abilities:** ${c.abilities}`].filter(Boolean).join('  \n')}\n`).join('\n') : '_Not decided yet._\n',
    '## Mechanics', '',
    d.mechanics.length ? d.mechanics.map(m => [
      `### ${m.name} (${m.status})`, '',
      m.summary,
      m.loop.length ? `**Loop:** ${m.loop.join(' → ')}` : '',
      m.decisions.length ? `**The player weighs up:**\n\n${list(m.decisions)}` : '',
      m.parameters.length ? `**Levers:**\n\n${m.parameters.map(p => `- ${p.name}${p.value ? ` = ${p.value}` : ''}${p.effect ? `: ${p.effect}` : ''}`).join('\n')}` : '',
      m.prototype.firstStep ? `**Prototype:** ${m.prototype.firstStep}${m.prototype.pitfall ? ` Watch out: ${m.prototype.pitfall}` : ''}` : '',
      m.prototype.test ? `**Playtest question:** ${m.prototype.test}${m.prototype.result ? ` **Answer:** ${m.prototype.result}` : ''}` : '',
      m.atlasId ? `_Based on Gameplay Atlas: ${m.atlasId} (loopyhop)._` : '',
      m.notes,
    ].filter(Boolean).join('\n\n')).join('\n\n') : '_None yet: the template\'s own systems (exploring, battles, levelling, shops) are the core._',
    '',
    '## World', '',
    d.world.regions.length ? d.world.regions.map(r => `- **${r.name}**${r.map ? ` (map \`${r.map}\`)` : ''}: ${r.description}${r.mood ? ` Mood: ${r.mood}.` : ''}`).join('\n') : '_Not decided yet._',
    '',
    '## Systems', '',
    `**Battle:** ${d.systems.battle}`, '',
    `**Progression:** ${d.systems.progression}`, '',
    `**Economy:** ${d.systems.economy}`, '',
    '## Audio', '',
    `**Mood:** ${or(d.audio.mood)}`, '',
    d.audio.tracks.length ? `${list(d.audio.tracks)}\n` : '',
    '## Scope', '',
    `**First playable:** ${or(d.scope.firstPlayable)}`, '',
    d.scope.later.length ? `**Later:**\n\n${list(d.scope.later)}\n` : '',
    '## Progress', '',
    PHASE_IDS.map(phaseLine).join('\n'), '',
    '## Decisions', '',
    d.decisions.length ? d.decisions.map(x => `- ${x.date}: ${x.decision}${x.why ? ` (${x.why})` : ''}`).join('\n') : '_None yet._',
    '',
  ].filter(line => line !== '').join('\n').replace(/\n(#+ )/g, '\n\n$1') + '\n'
}

export const PHASE_TITLES: Record<PhaseId, string> = {
  concept: 'Concept: what the game is',
  project: 'Project: a game that runs',
  art: 'Art direction',
  characters: 'Characters',
  world: 'World and maps',
  battle: 'Battle system',
  items: 'Items, shops and progression',
  story: 'Story and dialogue',
  ui: 'Title screen, menus and UI',
  audio: 'Music and sound',
  balance: 'Playtest and balance',
  build: 'Build and share',
}
