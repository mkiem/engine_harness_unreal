// Imports loopyhop's two design references into catalog/loopyhop/, used with the author's permission:
//   mechanics.json   Gameplay Atlas (https://gameplayatlas.loopyhop.com): 280 mechanic cards in 28 groups
//   art-styles.json  Game Art Style (https://gameartstyle.loopyhop.com): 37 visual styles with art-direction prompts
// Only loopyhop's own text and data are kept. Game screenshots belong to each game's rights holders and are not
// included: every reference keeps its official store or wiki link instead.
//   node scripts/import-loopyhop.ts            (fetches both sites and rewrites the catalogue; behind a proxy, add
//                                               NODE_USE_ENV_PROXY=1 so Node's fetch uses HTTPS_PROXY)
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'catalog', 'loopyhop')
const ATLAS = 'https://gameplayatlas.loopyhop.com'
const STYLES = 'https://gameartstyle.loopyhop.com'
const headers = { 'User-Agent': 'EngineHarness-catalog-import' }

async function get(url: string): Promise<string> {
  const response = await fetch(url, { headers })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return response.text()
}

const decode = (text: string) => text.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
const en = (value: any): any => {
  if (Array.isArray(value)) return value.map(en)
  if (value && typeof value === 'object') return 'en' in value ? value.en : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, en(v)]))
  return value
}

// ---- Gameplay Atlas ------------------------------------------------------------------------------------------------

async function importAtlas() {
  const home = await get(`${ATLAS}/`)
  const asset = /\/assets\/([a-z0-9]+)\/app\.js/.exec(home)?.[1]
  if (!asset) throw new Error('could not find the Gameplay Atlas app bundle')
  const app = await get(`${ATLAS}/assets/${asset}/app.js`)
  const catalog = JSON.parse(await get(`${ATLAS}/assets/${asset}/catalog.json`)) as any[]
  // Group labels sit in the bundle as ['id', '<Chinese name>', '<English name>', 'icon']; the Chinese name tells them
  // apart from other four-word lists.
  const used = new Set(catalog.map(m => m.system))
  const groups = Object.fromEntries([...app.matchAll(/\['([a-z]+)','([^']*)','([^']*)','[a-z-]+'\]/g)]
    .filter(m => /[^\x00-\x7f]/.test(m[2]!) && used.has(m[1]!)).map(m => [m[1]!, m[3]!]))
  const families = [...app.matchAll(/\{id:'([a-z-]+)',name:\{zh:'[^']*',en:'([^']*)'\},systems:\[([^\]]*)\]\}/g)]
    .map(m => ({ id: m[1]!, name: m[2]!, groups: m[3]!.split(',').map(s => s.replace(/'/g, '').trim()) }))
  const mechanics = catalog.map(raw => {
    const m = en(raw)
    return {
      id: m.id, name: m.name, group: m.system, summary: m.summary, tags: m.tags, rules: m.rules, loop: m.loop,
      decisions: m.decisions, parameters: m.parameters,
      cases: (m.cases ?? []).map((c: any) => ({ game: c.game, implementation: c.implementation, source: c.source, sourceLabel: c.sourceLabel,
        officialPage: c.imageSource, rights: c.rights, verified: c.verified })),
      contrast: m.contrast, combinesWith: m.combinesWith, combination: m.combination, related: m.related,
      walkthrough: m.walkthrough, prototype: m.prototype,
      url: `${ATLAS}/mechanic/${m.id}/`,
    }
  })
  return { source: ATLAS, imported: new Date().toISOString().slice(0, 10), families, groups, mechanics }
}

// ---- Game Art Style ------------------------------------------------------------------------------------------------

function parseStyle(slug: string, page: string) {
  const text = (pattern: RegExp) => { const m = pattern.exec(page); return m ? decode(m[1]!) : '' }
  const eyebrow = /<p class="eyebrow">([\s\S]*?)<\/p>/.exec(page)?.[1] ?? ''
  const family = decode(/<span[^>]*>([\s\S]*?)<\/span>/.exec(eyebrow)?.[1] ?? '')
  const name = text(/<h1>([\s\S]*?)<\/h1>/)
  const definition = text(/<p class="detail-description">([\s\S]*?)<\/p>/)
  const features = /<section class="features">([\s\S]*?)<\/section>/.exec(page)?.[1] ?? ''
  const lookFor = [...features.matchAll(/<p>([\s\S]*?)<\/p>/g)].map(m => decode(m[1]!))
  const prompt = text(/id="art-prompt-text"[^>]*>([\s\S]*?)<\/(?:code|pre|div)>/) || decode((/<div class="prompt-card">([\s\S]*?)<\/section>/.exec(page)?.[1] ?? '').replace(/ENGLISH PROMPT/, ''))
  const references = [...page.matchAll(/<article class="game-card">([\s\S]*?)<\/article>/g)].map(m => {
    const card = m[1]!
    return {
      game: decode(/<h3>([\s\S]*?)<\/h3>/.exec(card)?.[1] ?? ''),
      studio: decode(/<p class="game-developer">([\s\S]*?)<\/p>/.exec(card)?.[1] ?? ''),
      why: decode(/<p class="selection-reason">([\s\S]*?)<\/p>/.exec(card)?.[1] ?? ''),
      officialPage: /<a class="source-link" href="([^"]+)"/.exec(card)?.[1] ?? '',
    }
  })
  if (!name || !definition || lookFor.length === 0 || prompt.length < 200) throw new Error(`could not read the style page ${slug}`)
  return { id: slug, family, name, definition, lookFor, prompt, references, url: `${STYLES}/styles/${slug}/` }
}

async function importStyles() {
  const home = await get(`${STYLES}/`)
  const slugs = [...new Set([...home.matchAll(/href="\/styles\/([a-z0-9-]+)\/"/g)].map(m => m[1]!))].sort()
  const styles = []
  for (const slug of slugs) styles.push(parseStyle(slug, await get(`${STYLES}/styles/${slug}/`)))
  return { source: STYLES, imported: new Date().toISOString().slice(0, 10), styles }
}

const atlas = await importAtlas()
const styles = await importStyles()
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'mechanics.json'), `${JSON.stringify(atlas, null, 1)}\n`)
writeFileSync(join(out, 'art-styles.json'), `${JSON.stringify(styles, null, 1)}\n`)
console.log(`${atlas.mechanics.length} mechanics in ${Object.keys(atlas.groups).length} groups; ${styles.styles.length} art styles -> ${out}`)
