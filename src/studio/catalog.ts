/**
 * loopyhop's Gameplay Atlas (280 mechanic cards) and Game Art Style (37 visual styles), bundled with the author's
 * permission (catalog/loopyhop/NOTICE.md): searched by the studio tools so a beginner can pick a mechanic or a look
 * from real references, then turn it into their own design.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { GameDesign } from './design.ts'

export interface Mechanic {
  id: string; name: string; group: string; summary: string; tags: string[]; rules: string; loop: string[]
  decisions: string[]; parameters: { name: string; effect: string }[]
  cases: { game: string; implementation: string; source: string; sourceLabel: string; officialPage: string; rights: string }[]
  contrast: string; combinesWith: string[]; combination: string; related: string[]
  walkthrough: { setup: string; action: string; result: string; next: string }
  prototype: { scope: string; interaction: string; firstStep: string; pitfall: string; test: string }
  url: string
}
export interface ArtStyle {
  id: string; family: string; name: string; definition: string; lookFor: string[]; prompt: string
  references: { game: string; studio: string; why: string; officialPage: string }[]; url: string
}
export interface Catalog {
  groups: Record<string, string>; families: { id: string; name: string; groups: string[] }[]
  mechanics: Mechanic[]; styles: ArtStyle[]
}

export const ATLAS_CREDIT = 'From Gameplay Atlas by loopyhop (gameplayatlas.loopyhop.com), used with permission.'
export const STYLE_CREDIT = 'From Game Art Style by loopyhop (gameartstyle.loopyhop.com), used with permission. Game screenshots are not included; references link to official pages.'

export function defaultCatalogDir(here: string): string {
  for (const candidate of [join(here, 'catalog'), join(here, '..', '..', 'catalog')]) if (existsSync(join(candidate, 'loopyhop', 'mechanics.json'))) return resolve(candidate)
  return resolve(here, '..', '..', 'catalog')
}

const cache = new Map<string, Catalog>()
export function loadCatalog(dir: string): Catalog {
  const hit = cache.get(dir)
  if (hit) return hit
  const atlas = JSON.parse(readFileSync(join(dir, 'loopyhop', 'mechanics.json'), 'utf8'))
  const styles = JSON.parse(readFileSync(join(dir, 'loopyhop', 'art-styles.json'), 'utf8'))
  const catalog = { groups: atlas.groups, families: atlas.families, mechanics: atlas.mechanics, styles: styles.styles }
  cache.set(dir, catalog)
  return catalog
}

const SYNONYMS: Record<string, string> = {
  snes: '16 bit', genesis: '16 bit', megadrive: '16 bit', nes: '8 bit', gameboy: 'monochrome 8 bit', retro: 'pixel', cozy: 'cosy',
  cosy: 'farming relationship decorative storybook gift', craft: 'recipe automation production', crafting: 'recipe automation production',
  boss: 'stagger weak point part destruction intent', telegraph: 'intent preview', taunt: 'redirect attention threat front line',
  rpg: 'turn order party specialization', jrpg: 'turn order party specialization', minigame: 'small', anime: 'anime cel',
}
const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1).map(w => w.replace(/(ing|es|s)$/, ''))
const queryWords = (text: string) => words(text.toLowerCase().split(/[^a-z0-9]+/).map(w => `${w} ${SYNONYMS[w] ?? ''}`).join(' '))
const STOP = new Set(['the', 'and', 'for', 'with', 'game', 'my', 'want', 'like', 'that', 'thi', 'to', 'of', 'in', 'on', 'it', 'is', 'an', 'or'])

/** Scores how well text fields match the query words: whole-field weights, so a name match beats a passing mention. */
function score(query: string[], fields: [string, number][]): number {
  let total = 0
  for (const [text, weight] of fields) {
    const have = new Set(words(text))
    for (const q of query) if (have.has(q)) total += weight
  }
  return total
}

export function findMechanics(catalog: Catalog, options: { query?: string; group?: string; tag?: string; scope?: string; limit?: number }): Mechanic[] {
  const query = queryWords(options.query ?? '').filter(w => !STOP.has(w))
  let list = catalog.mechanics.filter(m =>
    (!options.group || m.group === options.group || catalog.groups[m.group]?.toLowerCase() === options.group.toLowerCase())
    && (!options.tag || m.tags.includes(options.tag))
    && (!options.scope || m.prototype.scope === options.scope))
  if (query.length) {
    const scored = list.map(m => ({ m, s: score(query, [[m.name, 6], [m.summary, 3], [m.tags.join(' '), 3], [catalog.groups[m.group] ?? m.group, 2],
      [m.loop.join(' '), 1.5], [m.rules, 1], [m.decisions.join(' '), 1], [m.cases.map(c => c.game).join(' '), 2]]) }))
    list = scored.filter(x => x.s > 0).sort((a, b) => b.s - a.s).map(x => x.m)
  }
  return list.slice(0, options.limit ?? 8)
}

export function mechanicLine(catalog: Catalog, m: Mechanic): string {
  return `- ${m.id}: ${m.name} (${catalog.groups[m.group] ?? m.group}; ${m.prototype.scope} prototype). ${m.summary}\n  Loop: ${m.loop.join(' -> ')}`
}

/** A whole mechanic card as text, with its sources. */
export function mechanicCard(catalog: Catalog, m: Mechanic): string {
  const byId = new Map(catalog.mechanics.map(x => [x.id, x]))
  return [
    `# ${m.name} (${catalog.groups[m.group] ?? m.group})`,
    m.summary,
    '',
    `How it plays: ${m.rules}`,
    `Core loop: ${m.loop.map((step, i) => `${i + 1}. ${step}`).join('  ')}`,
    '',
    'What the player weighs up:', ...m.decisions.map(d => `- ${d}`),
    '',
    'Design levers (parameters):', ...m.parameters.map(p => `- ${p.name}: ${p.effect}`),
    '',
    'In real games:', ...m.cases.map(c => `- ${c.game}: ${c.implementation} (${c.sourceLabel}: ${c.source}${c.officialPage ? `; official page: ${c.officialPage}` : ''})`),
    m.contrast ? `Compared: ${m.contrast}` : '',
    '',
    `A round of it: ${m.walkthrough.setup} ${m.walkthrough.action} ${m.walkthrough.result} ${m.walkthrough.next}`,
    '',
    `Prototype (${m.prototype.scope}, ${m.prototype.interaction}):`,
    `- First step: ${m.prototype.firstStep}`,
    `- Watch out: ${m.prototype.pitfall}`,
    `- Playtest question: ${m.prototype.test}`,
    '',
    m.combination ? `Combination idea (with ${m.combinesWith.map(g => catalog.groups[g] ?? g).join(', ')}): ${m.combination}` : '',
    m.related.length ? `Related: ${m.related.map(id => `${id} (${byId.get(id)?.name ?? '?'})`).join(', ')}` : '',
    '',
    `${ATLAS_CREDIT} ${m.url}`,
  ].filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n')
}

export function findStyles(catalog: Catalog, options: { query?: string; family?: string }): ArtStyle[] {
  const query = queryWords(options.query ?? '').filter(w => !STOP.has(w))
  let list = catalog.styles.filter(s => !options.family || s.family.toLowerCase().includes(options.family.toLowerCase()))
  if (query.length) {
    list = list.map(s => ({ s, n: score(query, [[s.name, 6], [s.family, 3], [s.definition, 2], [s.lookFor.join(' '), 2], [s.references.map(r => r.game).join(' '), 3]]) }))
      .filter(x => x.n > 0).sort((a, b) => b.n - a.n).map(x => x.s)
  }
  return list
}

export function styleCard(s: ArtStyle, withPrompt = true): string {
  return [
    `# ${s.name} (${s.family})`,
    s.definition,
    '',
    'What to look for:', ...s.lookFor.map((f, i) => `${i + 1}. ${f}`),
    '',
    'Reference games (look at their official pages; do not copy their characters, logos or art):',
    ...s.references.map(r => `- ${r.game} (${r.studio}): ${r.why} ${r.officialPage}`),
    ...(withPrompt ? ['', 'Global art-direction prompt:', s.prompt] : []),
    '',
    `${STYLE_CREDIT} ${s.url}`,
  ].join('\n')
}

/**
 * design/ART_DIRECTION.md: the brief every picture follows. The chosen style's art-direction prompt with this game's
 * own specifications (resolution, sprite sizes, palette, rules, mistakes to avoid). Answers its path relative to the
 * project.
 */
export function writeArtDirection(project: string, design: GameDesign, style: ArtStyle): string {
  const art = design.art
  const list = (items: string[]) => items.length ? items.map(item => `- ${item}`).join('\n') : '- _Not decided yet._'
  const text = [
    `# Art direction: ${style.name}`,
    '',
    `${design.title}${design.pitch ? `: ${design.pitch}` : ''}`,
    '',
    '## The look',
    '',
    style.definition,
    '',
    '**In every picture:**',
    '',
    list(art.lookFor.length ? art.lookFor : style.lookFor),
    '',
    '## This game\'s specifications',
    '',
    `- Screen: ${art.resolution[0]}x${art.resolution[1]} pixels, scaled up with crisp pixels.`,
    `- Tiles ${art.tileSize}x${art.tileSize} in one row (art/tiles.png); hero ${art.tileSize}x${art.tileSize}, 2 walking frames x 4 directions (art/hero.png); map figures ${art.tileSize}x${art.tileSize} (art/npcs.png); enemies 32x32 (art/enemies.png).`,
    `- Palette${art.paletteLocked ? ' (locked: use only these colours)' : ' (not locked yet)'}: ${art.palette.length ? art.palette.join(' ') : '_not chosen yet_'}`,
    ...(Object.keys(art.rules).length ? ['', '**Rules:**', '', ...Object.entries(art.rules).map(([k, v]) => `- ${k}: ${v}`)] : []),
    '',
    '**Avoid:**',
    '',
    list(art.avoid),
    '',
    '## Art-direction brief',
    '',
    style.prompt,
    '',
    'Make every picture for this game within this direction and these specifications. When asked for one asset, deliver that asset; do not redesign the style for each request.',
    '',
    '## References',
    '',
    'Study how these games apply the style on their official pages; use original designs, never their characters, logos or artwork.',
    '',
    ...style.references.map(r => `- ${r.game} (${r.studio}): ${r.why} ${r.officialPage}`),
    '',
    `_${STYLE_CREDIT} ${style.url}_`,
    '',
  ].join('\n')
  mkdirSync(join(project, 'design'), { recursive: true })
  writeFileSync(join(project, 'design', 'ART_DIRECTION.md'), text)
  return 'design/ART_DIRECTION.md'
}
