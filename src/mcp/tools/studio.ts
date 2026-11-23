/**
 * Game Studio MCP tools: guided game creation, design document, phase checks, battle simulation,
 * Gameplay Atlas & Game Art Style references, pixel art, chiptune audio, Godot install, and Windows export.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { writeProvenance } from '../../assets/provenance.ts'
import { formatErrors, listScripts } from '../../godot/bridge.ts'
import { GODOT_VERSION, hasWindowsTemplates, installGodot, installWindowsTemplates } from '../../godot/install.ts'
import { ATLAS_CREDIT, findMechanics, findStyles, loadCatalog, mechanicCard, mechanicLine, STYLE_CREDIT, styleCard, writeArtDirection } from '../../studio/catalog.ts'
import { readDesign, renderDesign, updateDesign } from '../../studio/design.ts'
import { compose, imageOffPalette, nearestColor, offPalette, paint, preview, sound, SOUND_PRESETS, writeAudio } from '../../studio/make.ts'
import { balanceResults, battleGroups, describeNext, phaseReports } from '../../studio/phases.ts'
import { checkProjectData, createProject, slugOf, TEMPLATES } from '../../studio/project.ts'
import { reviewVisualAsset } from '../../studio/vlm.ts'
import { elicitConfirmation, emitProgress, failure, text, type HarnessContext, type ToolExtra } from '../context.ts'

const verdict = (r: { win_rate: number; avg_hp_left: number }) =>
  r.win_rate < 0.4 ? 'deadly' : r.win_rate < 0.75 ? 'hard' : r.win_rate >= 0.98 && r.avg_hp_left >= 0.75 ? 'easy' : 'fair'

const VoiceSchema = z.object({
  notes: z.string().describe('notes with lengths in beats, such as "C4 E4 G4:2 R A3:0.5" (R is a rest; sharps C#4, flats Bb3)'),
  wave: z.enum(['square', 'pulse', 'triangle', 'sine', 'saw', 'noise']).optional().describe('square/pulse: chiptune lead; triangle: soft lead or bass; sine: pure; saw: buzzy; noise: drums (higher notes are brighter)'),
  volume: z.number().min(0).max(1).optional(),
  envelope: z.enum(['pluck', 'hold', 'hit']).optional(),
})

export function registerStudioTools(ctx: HarnessContext): void {
  const { server, root, templatesDir, catalogDir, godot, godotBinary, resetGodotBinary, within, studioProject, insideProject, track } = ctx
  const studioFailure = (error: unknown) => failure((error as Error).message)

  track('studio', server.registerTool('studio_new_project', {
    title: 'Start a new game',
    description: 'Creates a playable Godot 4 game project (2D RPG or 3D starter) with its design document, after the concept interview. Then imports it with Godot when Godot is installed.',
    inputSchema: {
      title: z.string(), pitch: z.string().default(''),
      template: z.enum(TEMPLATES).optional().describe('starter template: "godot-rpg" (default, 2D turn-based RPG) or "godot-3d-starter" (3D character-ready starter)'),
      folder: z.string().optional().describe('where to create it; default: a new folder named after the game in the current folder'),
      resolution: z.tuple([z.number().int(), z.number().int()]).optional().describe('pixel resolution, default 320x180'),
      design: z.record(z.string(), z.unknown()).optional().describe('decisions from the interview, in the design document\'s shape'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ title, pitch, template, folder, resolution, design }) => {
    try {
      const target = folder ? within(folder) : join(root, slugOf(title))
      const made = createProject(templatesDir, { title, pitch, template, folder: target, resolution: resolution as [number, number] | undefined, design })
      let imported = 'Godot is not installed yet: run studio_install_godot, then the game can be played.'
      if (godotBinary()) {
        const result = await godot.importProject(made.project)
        imported = result.errors.length ? `Godot imported it with errors:\n${formatErrors(result.errors)}` : 'Godot imported the art and sound.'
      }
      const reports = phaseReports(made.project, readDesign(made.project))
      return text([`Created "${title}" in ${made.project} (${made.files} files). ${imported}`,
        'Tell the developer to open this folder in Engine Harness for future sessions, so it remembers the game.', '', describeNext(readDesign(made.project), reports)].join('\n'), { project: made.project })
    } catch (error) {
      return studioFailure(error)
    }
  }))

  track('studio', server.registerTool('studio_next', {
    title: 'What is next',
    description: 'Where the game stands: every phase from concept to build, the current one with its checklist, the skill to load, and the next concrete step. Run it at the start of every session.',
    inputSchema: { project: z.string().optional() },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async ({ project }) => {
    try {
      const dir = studioProject(project)
      const design = readDesign(dir)
      return text(describeNext(design, phaseReports(dir, design)), { project: dir })
    } catch (error) {
      return studioFailure(error)
    }
  }))

  track('studio', server.registerTool('studio_design_read', {
    title: 'Read the game design',
    description: 'The design document as text, or one section of it as JSON (such as "characters", "world", "concept", "art", "phases").',
    inputSchema: { section: z.string().optional(), project: z.string().optional() },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async ({ section, project }) => {
    try {
      const design = readDesign(studioProject(project)) as Record<string, unknown>
      if (!section) return text(renderDesign(design as ReturnType<typeof readDesign>))
      if (!(section in design)) return failure(`no section ${section}; sections: ${Object.keys(design).join(', ')}`)
      return text(JSON.stringify(design[section], null, 2))
    } catch (error) {
      return studioFailure(error)
    }
  }))

  track('studio', server.registerTool('studio_design_update', {
    title: 'Record design decisions',
    description: 'Merges changes into the design document (objects merge, lists and values replace, null removes) and rewrites GAME_DESIGN.md. Pass the decision in words, with why, so the decisions log stays readable. Mark a phase done with {"phases": {"<id>": {"status": "done"}}} only when the developer agrees.',
    inputSchema: { patch: z.record(z.string(), z.unknown()), decision: z.string().optional(), why: z.string().optional(), project: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ patch, decision, why, project }) => {
    try {
      const dir = studioProject(project)
      const design = updateDesign(dir, patch, decision ? { decision, why } : undefined)
      if ('art' in patch && design.art.styleId) {
        const style = loadCatalog(catalogDir).styles.find(s => s.id === design.art.styleId)
        if (style) writeArtDirection(dir, design, style)
      }
      const reports = phaseReports(dir, design)
      const current = reports.find(r => r.status !== 'done')
      return text(`Design updated (${Object.keys(patch).join(', ')}).${current ? ` Current phase: ${current.title}, ${current.checks.filter(c => c.done).length}/${current.checks.length} checks done.` : ' Every phase is done.'}`)
    } catch (error) {
      return failure(`the change does not fit the design document: ${(error as Error).message}`)
    }
  }))

  track('studio', server.registerTool('studio_check', {
    title: 'Check the whole game',
    description: 'Checks the game: every reference between its data files, every script (with Godot), the game\'s self-test (formulas, levelling, saving), and a real run of the title screen and a walk on the map into a battle. Run after any change.',
    inputSchema: { project: z.string().optional(), quick: z.boolean().default(false).describe('data checks only, without starting Godot') },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async ({ project, quick }, extra) => {
    try {
      const dir = studioProject(project)
      const lines: string[] = []
      await emitProgress(extra as ToolExtra, 1, quick ? 2 : 5, 'Checking project data references...')
      const problems = checkProjectData(dir)
      lines.push(problems.length ? `✗ Data: ${problems.length} problem(s)\n${problems.map(p => `  - ${p}`).join('\n')}` : '✓ Data: every reference between the data files resolves')
      const art = readDesign(dir).art
      if (art.paletteLocked && art.palette.length) {
        const offenders = ['art/tiles.png', 'art/hero.png', 'art/npcs.png', 'art/enemies.png'].filter(f => existsSync(join(dir, f)))
          .map(f => ({ f, ...imageOffPalette(dir, f, art.palette) })).filter(r => r.off.length)
        lines.push(offenders.length ? `· Palette: pictures with colours outside the locked palette (${art.palette.length} colours):\n${offenders.map(r => `  - ${r.f}: ${r.off.length} of ${r.colors} colours (${r.off.slice(0, 6).join(' ')}${r.off.length > 6 ? ' ...' : ''})`).join('\n')}` : `✓ Palette: every picture uses only the locked palette`)
      }
      if (!quick) {
        if (!godotBinary()) lines.push('· Godot is not installed, so scripts and the game were not run (studio_install_godot installs it)')
        else {
          await emitProgress(extra as ToolExtra, 2, 5, 'Importing project and checking GDScript...')
          await godot.importProject(dir)
          const scripts = await godot.check(dir, listScripts(dir))
          lines.push(scripts.errors.length ? `✗ Scripts: ${scripts.errors.length} error(s)\n${formatErrors(scripts.errors)}` : `✓ Scripts: ${scripts.checked} parse cleanly`)
          if (scripts.errors.length) lines.push('· The game was not run: fix the scripts first')
        }
        if (godotBinary() && !lines.some(line => line.startsWith('✗ Scripts'))) {
          if (existsSync(join(dir, 'tools', 'self_test.tscn'))) {
            await emitProgress(extra as ToolExtra, 3, 5, 'Running Godot self-test...')
            const self = await godot.exec(dir, ['res://tools/self_test.tscn'])
            const fails = `${self.stdout}\n${self.stderr}`.split(/\r?\n/).filter(line => line.startsWith('SELFTEST FAIL')).map(line => line.slice(14))
            lines.push(fails.length || self.errors.length ? `✗ Self-test:\n${[...fails, ...self.errors.map(e => e.message)].map(f => `  - ${f}`).join('\n')}` : '✓ Self-test: formulas, levelling and saving work')
          }
          await emitProgress(extra as ToolExtra, 4, 5, 'Running automated scene walkthroughs...')
          for (const [scene, label] of [['res://scenes/main_menu.tscn', 'Title screen'], ['res://scenes/overworld.tscn', 'Map walk into a battle'], ['res://scenes/ending.tscn', 'Ending']] as const) {
            if (!existsSync(join(dir, scene.replace(/^res:\/\//, '')))) continue
            const run = await godot.exec(dir, [scene, '--', '--autotest'], 40_000)
            const out = `${run.stdout}\n${run.stderr}`
            const reached = out.match(/AUTOTEST [^\n]+/g) ?? []
            if (run.errors.length) lines.push(`✗ ${label}:\n${formatErrors(run.errors)}`)
            else if (run.timedOut || !reached.length) lines.push(`✗ ${label}: the game did not finish its test run${run.timedOut ? ' within 40 seconds' : ''}${reached.length ? ` (got as far as: ${reached.map(r => r.replace('AUTOTEST ', '')).join('; ')})` : ''}`)
            else lines.push(`✓ ${label}: ${reached.map(r => r.replace('AUTOTEST ', '')).join('; ')}`)
          }
        }
      }
      await emitProgress(extra as ToolExtra, quick ? 2 : 5, quick ? 2 : 5, 'Checks complete.')
      const ok = !lines.some(line => line.startsWith('✗'))
      return { ...text(`${ok ? 'The game checks out.' : 'Something needs fixing.'}\n${lines.join('\n')}`, { ok }), ...(ok ? {} : { isError: true }) }
    } catch (error) {
      return studioFailure(error)
    }
  }))

  track('studio', server.registerTool('studio_simulate_battle', {
    title: 'Simulate battles for balance',
    description: 'Fights battles many times with the game\'s real rules (equipment, elements, statuses, enemy AI and boss phases included) and reports win rate, length and HP left, with a verdict (easy, fair, hard, deadly). Without enemies, simulates every encounter group and every story battle. Results are kept for the balance phase.',
    inputSchema: {
      enemies: z.array(z.string()).optional().describe('one group, such as ["wolf", "slime"]'),
      level: z.number().int().min(1).max(99).default(1).describe('the party level to test at'),
      party: z.array(z.string()).optional().describe('character ids in the party, with their starting equipment; default the starting party (add members who join later, such as ["hero", "mage", "ranger"])'),
      runs: z.number().int().min(10).max(2000).default(300),
      project: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ enemies, level, party, runs, project }, extra) => {
    try {
      const dir = studioProject(project)
      if (!godotBinary()) return failure('Godot is needed to simulate battles: run studio_install_godot first')
      const groups: string[][] = enemies?.length ? [enemies] : battleGroups(dir)
      await godot.importProject(dir)
      const store = join(dir, '.studio', 'balance.json')
      const saved = { results: balanceResults(dir) as Record<string, unknown> }
      const lines: string[] = []
      for (let i = 0; i < groups.length; i++) {
        const group = groups[i]!
        await emitProgress(extra as ToolExtra, i + 1, groups.length, `Simulating ${group.join(' + ')}...`)
        const run = await godot.exec(dir, ['res://tools/sim_battle.tscn', '--', '--enemies', group.join(','), '--runs', String(runs), '--level', String(level), ...(party?.length ? ['--party', party.join(',')] : [])])
        const line = `${run.stdout}`.split(/\r?\n/).find(l => l.startsWith('SIM_RESULT '))
        if (!line) { lines.push(`${group.join(' + ')}: the simulation did not finish${run.errors.length ? `\n${formatErrors(run.errors)}` : ''}`); continue }
        const r = JSON.parse(line.slice(11)) as { win_rate: number; avg_turns: number; avg_hp_left: number; level: number; enemies: string[]; party: string[] }
        saved.results[`${group.join('+')}@${level}${party?.length ? `:${party.join('+')}` : ''}`] = { ...r, at: new Date().toISOString() }
        lines.push(`${group.join(' + ')} at level ${level} (${r.party.join(', ')}): ${verdict(r)}. Wins ${Math.round(r.win_rate * 100)}%, ${r.avg_turns.toFixed(1)} turns, ${Math.round(r.avg_hp_left * 100)}% HP left`)
      }
      mkdirSync(dirname(store), { recursive: true })
      writeFileSync(store, `${JSON.stringify(saved, null, 2)}\n`)
      return text(`${lines.join('\n')}\n\nAs a guide: ordinary battles "easy" to "fair", a region's toughest groups "fair" to "hard", bosses "hard". Change numbers in data/enemies.json, data/skills.json or data/formulas.json and simulate again.`)
    } catch (error) {
      return studioFailure(error)
    }
  }))

  track('studio', server.registerTool('studio_find_mechanic', {
    title: 'Find game mechanics',
    description: 'Searches the Gameplay Atlas: 280 game mechanics from real games in 28 groups (combat, command, progression, inventory, exploration, relationships, narrative, fishing, farming, cooking, puzzles, stealth...), each a loop of player action with its trade-offs, design levers and a small prototype plan. Search by what the developer wants ("enemy telegraphs", "something cosy between battles", "fishing"), or list a group. Read one with studio_mechanic.',
    inputSchema: {
      query: z.string().optional(), group: z.string().optional().describe('a group id such as combat, command, progression, fishing'),
      tag: z.string().optional().describe('planning, risk, spatial, optimization, information, timing, economy, progression, time, precision, discovery, dexterity, narrative, creativity, cooperation, randomness'),
      scope: z.enum(['small', 'medium', 'large']).optional().describe('prototype size'), limit: z.number().int().min(1).max(40).default(8),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async ({ query, group, tag, scope, limit }) => {
    try {
      const catalog = loadCatalog(catalogDir)
      if (!query && !group && !tag && !scope) {
        const lines = catalog.families.map(f => `${f.name}: ${f.groups.map(g => `${g} (${catalog.groups[g]}, ${catalog.mechanics.filter(m => m.group === g).length})`).join(', ')}`)
        return text(`The Gameplay Atlas has ${catalog.mechanics.length} mechanics. Groups by family:\n${lines.join('\n')}\n\nSearch with query, or list a group.\n${ATLAS_CREDIT}`)
      }
      const found = findMechanics(catalog, { query, group, tag, scope, limit })
      if (!found.length) return text(`No mechanic matches. Groups: ${Object.entries(catalog.groups).map(([id, name]) => `${id} (${name})`).join(', ')}`)
      return text(`${found.map(m => mechanicLine(catalog, m)).join('\n')}\n\nRead one with studio_mechanic.\n${ATLAS_CREDIT}`, { ids: found.map(m => m.id) })
    } catch (error) {
      return studioFailure(error)
    }
  }))

  track('studio', server.registerTool('studio_mechanic', {
    title: 'Read a mechanic card',
    description: 'One Gameplay Atlas mechanic in full: how it plays, the core loop, what the player weighs up, design levers, how real games do it (with sources), a walkthrough, prototype guidance (first step, pitfall, playtest question) and combinations. With add: true it is also added to the game\'s design as a mechanic card (status "idea") to make the game\'s own.',
    inputSchema: { id: z.string(), add: z.boolean().default(false), project: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ id, add, project }) => {
    try {
      const catalog = loadCatalog(catalogDir)
      const m = catalog.mechanics.find(x => x.id === id) ?? findMechanics(catalog, { query: id, limit: 1 })[0]
      if (!m) return failure(`no mechanic ${id}; search with studio_find_mechanic`)
      let added = ''
      if (add) {
        const dir = studioProject(project)
        const design = readDesign(dir)
        if (design.mechanics.some(card => card.atlasId === m.id)) added = '\n\nIt is already in the design.'
        else {
          updateDesign(dir, { mechanics: [...design.mechanics, {
            name: m.name, atlasId: m.id, summary: m.summary, loop: m.loop, decisions: m.decisions,
            parameters: m.parameters.map(p => ({ name: p.name, value: '', effect: p.effect })),
            prototype: { firstStep: m.prototype.firstStep, pitfall: m.prototype.pitfall, test: m.prototype.test, result: '' }, status: 'idea', notes: '',
          }] }, { decision: `Considering the mechanic "${m.name}"`, why: m.summary })
          added = '\n\nAdded to the design as a mechanic card (status "idea"). Now make it this game\'s own: rewrite the loop in the game\'s words, set the levers, then build only the prototype\'s first step.'
        }
      }
      return text(mechanicCard(catalog, m) + added, { id: m.id })
    } catch (error) {
      return studioFailure(error)
    }
  }))

  track('studio', server.registerTool('studio_art_styles', {
    title: 'Browse art styles',
    description: 'Lists the 37 visual styles of Game Art Style (pixel & retro, 3D & rendering, paint & line, shape & material), each with what defines it and reference games. Search by words ("16-bit", "watercolor", "dark ink") or family. Read one in full, and apply it to the game, with studio_art_style.',
    inputSchema: { query: z.string().optional(), family: z.string().optional() },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async ({ query, family }) => {
    try {
      const found = findStyles(loadCatalog(catalogDir), { query, family })
      if (!found.length) return text('No style matches; try fewer words, or no query to list them all.')
      return text(`${found.map(s => `- ${s.id}: ${s.name} (${s.family}). ${s.definition} Like ${s.references.map(r => r.game).join(', ')}.`).join('\n')}\n\n${STYLE_CREDIT}`, { ids: found.map(s => s.id) })
    } catch (error) {
      return studioFailure(error)
    }
  }))

  track('studio', server.registerTool('studio_art_style', {
    title: 'Read or apply an art style',
    description: 'One Game Art Style entry in full: definition, what to look for, reference games (official pages) and its global art-direction prompt. With apply: true it becomes the game\'s art direction: the design records the style and what to look for, and design/ART_DIRECTION.md is written (the prompt plus this game\'s resolution, tiles, palette and rules), which every later art request follows.',
    inputSchema: { id: z.string(), apply: z.boolean().default(false), project: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ id, apply, project }) => {
    try {
      const catalog = loadCatalog(catalogDir)
      const style = catalog.styles.find(s => s.id === id) ?? findStyles(catalog, { query: id })[0]
      if (!style) return failure(`no style ${id}; list them with studio_art_styles`)
      if (!apply) return text(styleCard(style), { id: style.id })
      const dir = studioProject(project)
      const design = updateDesign(dir, { art: { styleId: style.id, style: readDesign(dir).art.style || style.name, lookFor: style.lookFor,
        references: style.references.map(r => `${r.game}: ${r.officialPage}`) } }, { decision: `Art direction: ${style.name}`, why: style.definition })
      const path = writeArtDirection(dir, design, style)
      return text(`${styleCard(style, false)}\n\nApplied: the design records the style and what to look for, and ${path} holds the full art direction for every later picture. Next: agree a palette (art.palette) and lock it (art.paletteLocked: true), then write the art bible's rules (art.rules) and mistakes to avoid (art.avoid) with the developer.`, { id: style.id, file: path })
    } catch (error) {
      return studioFailure(error)
    }
  }))

  track('studio', server.registerTool('studio_test_event', {
    title: 'Test a story event',
    description: 'Plays a story event from data/events.json without the screen, as the game would, and reports every line said, each choice taken, what changed (flags, items, gold, quests, the party) and what stopped it (a battle, the ending). Set up the situation first with flags, items, quests and members. Use it after writing or changing an event, and try each branch.',
    inputSchema: {
      event: z.string(),
      choices: z.array(z.number().int().min(0)).optional().describe('the option to pick at each choice, in order (default: the first)'),
      flags: z.array(z.string()).optional(), items: z.record(z.string(), z.number().int()).optional(),
      quests: z.record(z.string(), z.string()).optional().describe('quest id to stage'), members: z.array(z.string()).optional().describe('characters who have joined'),
      gold: z.number().int().optional(), map: z.string().optional().describe('the map the event happens on (for hide/show)'),
      project: z.string().optional(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async ({ event, choices, flags, items, quests, members, gold, map, project }) => {
    try {
      const dir = studioProject(project)
      if (!godotBinary()) return failure('Godot is needed to play events: run studio_install_godot first')
      await godot.importProject(dir)
      const args = ['res://tools/event_test.tscn', '--', '--event', event]
      if (choices?.length) args.push('--choices', choices.join(','))
      if (flags?.length) args.push('--flags', flags.join(','))
      if (items && Object.keys(items).length) args.push('--items', Object.entries(items).map(([id, n]) => `${id}:${n}`).join(','))
      if (quests && Object.keys(quests).length) args.push('--quests', Object.entries(quests).map(([id, stage]) => `${id}=${stage}`).join(','))
      if (members?.length) args.push('--members', members.join(','))
      if (gold !== undefined) args.push('--gold', String(gold))
      if (map) args.push('--map', map)
      const run = await godot.exec(dir, args, 60_000)
      const line = run.stdout.split(/\r?\n/).find(l => l.startsWith('EVENT_RESULT '))
      if (!line) return failure(`the event did not finish${run.errors.length ? `:\n${formatErrors(run.errors)}` : ''}`)
      const r = JSON.parse(line.slice(13))
      if (r.error) return failure(r.error)
      const out = [
        ...r.said.map((l: string) => `  ${l}`),
        ...r.choices.map((c: { question: string; options: string[]; picked: number }) => `Choice "${c.question}": picked "${c.options[c.picked] ?? c.picked}" of ${c.options.map((o: string) => `"${o}"`).join(', ')}`),
        `Changes: ${Object.keys(r.changes).length ? JSON.stringify(r.changes) : 'none'}`,
        r.stopped_by?.battle ? `Stopped by a battle against ${r.stopped_by.battle.join(', ')}${r.stopped_by.ending ? ' that ends the game' : ''}` : r.stopped_by?.ending ? 'Stopped by the ending' : 'Ran to the end',
        ...(r.problems.length ? ['Problems:', ...r.problems.map((p: string) => `  - ${p}`)] : []),
      ]
      return text(`Event ${event}:\n${out.join('\n')}`, r)
    } catch (error) {
      return studioFailure(error)
    }
  }))

  track('studio', server.registerTool('studio_paint', {
    title: 'Paint pixel art',
    description: 'Paints pixel art from a text grid into an image in the game (one character per pixel; the palette names each character\'s colour; "." is transparent). Paints one frame of a sprite sheet, growing the sheet when needed: tiles are 16x16 frames in one row of art/tiles.png, the hero is 2 columns x 4 rows (down, left, right, up) of art/hero.png, NPCs are 16x16 frames of art/npcs.png, enemies 32x32 frames of art/enemies.png. Look at the result with studio_preview.',
    inputSchema: {
      file: z.string().describe('image in the game, such as art/enemies.png'),
      rows: z.array(z.string()).min(1).describe('one string per pixel row'),
      palette: z.record(z.string(), z.string()).describe('character to "#rrggbb" (or "transparent")'),
      at: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional().describe('[column, row] of the frame in the sheet, default [0, 0]'),
      frame: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional().describe('frame size in pixels, default the grid size'),
      snapToPalette: z.boolean().default(false).describe('with a locked palette in the design, replace every colour with the nearest palette colour'),
      project: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ file, rows, palette, at, frame, snapToPalette, project }) => {
    try {
      const dir = studioProject(project)
      const art = readDesign(dir).art
      let colors = palette
      let note = ''
      if (art.paletteLocked && art.palette.length) {
        const off = offPalette(Object.values(palette), art.palette)
        if (off.length && snapToPalette) {
          colors = Object.fromEntries(Object.entries(palette).map(([k, c]) => [k, offPalette([c], art.palette).length ? nearestColor(c, art.palette) : c]))
          note = ` Snapped ${off.length} colour(s) to the locked palette: ${off.map(c => `${c} -> ${nearestColor(c, art.palette)}`).join(', ')}.`
        } else if (off.length) {
          note = ` Warning: ${off.length} colour(s) are not in the locked palette (${off.map(c => `${c}, nearest ${nearestColor(c, art.palette)}`).join('; ')}). Repaint with palette colours, or call again with snapToPalette: true.`
        }
      }
      const done = paint(dir, { file: insideProject(dir, file), rows, palette: colors, at: at as [number, number] | undefined, frame: frame as [number, number] | undefined })
      writeProvenance(join(dir, done.file), { assetId: done.file, file: done.file, method: 'procedural', tool: 'studio_paint', license: 'proprietary' })
      const shown = preview(dir, done.file, { frame: [done.frameWidth, done.frameHeight] })
      return text(`Painted a ${done.frameWidth}x${done.frameHeight} frame at pixel ${done.x},${done.y} of ${done.file} (${done.colors} colours; the sheet is ${done.width}x${done.height}${done.grew ? ', grown to fit' : ''}). Enlarged preview: ${shown.path}${note}`, { ...done, preview: shown.path })
    } catch (error) {
      return studioFailure(error)
    }
  }))

  track('studio', server.registerTool('studio_preview', {
    title: 'Look at an image enlarged',
    description: 'Writes an enlarged copy of a game image (on a checkerboard, with lines between frames) to .studio/previews/ so it can be looked at; answers its path. Open the preview to check pixel art before showing it in the game.',
    inputSchema: {
      file: z.string(), scale: z.number().int().min(1).max(32).optional(),
      frame: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional().describe('frame size, to draw lines between frames'),
      project: z.string().optional(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async ({ file, scale, frame, project }) => {
    try {
      const dir = studioProject(project)
      const shown = preview(dir, insideProject(dir, file), { scale, frame: frame as [number, number] | undefined })
      return text(`Preview (${shown.width}x${shown.height}): ${shown.path}`, { ...shown })
    } catch (error) {
      return studioFailure(error)
    }
  }))

  track('studio', server.registerTool('studio_music', {
    title: 'Write music',
    description: 'Writes a music track or jingle from notes: several voices (melody, bass, drums) played together at a tempo, as a WAV in audio/. The game loops music tracks. Music for places is set in maps/maps.json ("music"), the title and battle music in data/game.json.',
    inputSchema: {
      file: z.string().describe('such as "town" (audio/town.wav) or "audio/boss.wav"'),
      tempo: z.number().min(20).max(400).describe('beats per minute; 70-90 calm, 100-120 walking, 140-170 battle'),
      voices: z.array(VoiceSchema).min(1),
      repeat: z.number().int().min(1).max(16).optional().describe('repeat the phrase this many times in the file'),
      project: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ file, tempo, voices, repeat, project }) => {
    try {
      const dir = studioProject(project)
      const made = compose(voices, tempo, { repeat })
      const written = writeAudio(dir, insideProject(dir, file), made.wav)
      writeProvenance(join(dir, written), { assetId: written, file: written, method: 'procedural', tool: 'studio_music', license: 'proprietary' })
      return text(`Wrote ${written} (${made.seconds.toFixed(1)} s). In the game it is res://${written}; play the game to hear it.`, { file: written, seconds: made.seconds })
    } catch (error) {
      return studioFailure(error)
    }
  }))

  track('studio', server.registerTool('studio_sound', {
    title: 'Make a sound effect',
    description: `Writes a sound effect into audio/ from a preset (${Object.entries(SOUND_PRESETS).map(([id, p]) => `${id}: ${p.about}`).join('; ')}), or from notes like studio_music. The game plays audio/<name>.wav for: select, hit, heal, magic, levelup, victory, defeat, coin, door, encounter, and a skill's own id when that file exists (audio/fire.wav for the skill "fire").`,
    inputSchema: {
      name: z.string().describe('file name in audio/, such as "hit" or "fire"'),
      preset: z.string().optional(),
      tempo: z.number().min(20).max(1200).optional(),
      voices: z.array(VoiceSchema).optional().describe('instead of a preset'),
      project: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ name, preset, tempo, voices, project }) => {
    try {
      const dir = studioProject(project)
      if (!preset && !voices?.length) return failure(`give a preset (${Object.keys(SOUND_PRESETS).join(', ')}) or voices`)
      const wav = voices?.length ? compose(voices, tempo ?? 480).wav : sound(preset!)
      const written = writeAudio(dir, insideProject(dir, name), wav)
      writeProvenance(join(dir, written), { assetId: written, file: written, method: 'procedural', tool: 'studio_sound', license: 'proprietary' })
      return text(`Wrote ${written}.`, { file: written })
    } catch (error) {
      return studioFailure(error)
    }
  }))

  track('studio', server.registerTool('studio_visual_review', {
    title: 'Visual QA review of a preview',
    description: 'Runs an advisory Vision-Language Model critique on a sprite preview, character turnaround, or turntable render against a visual rubric (silhouette, palette coherence, clipping, readability) before human review. Requires OPENAI_API_KEY or GEMINI_API_KEY.',
    inputSchema: {
      file: z.string().describe('path to a preview PNG/JPG inside the project'),
      rubric: z.string().describe('what to check (e.g. "clean silhouette, locked palette, no floating limbs")'),
      provider: z.enum(['openai', 'gemini']).default('openai'),
      model: z.string().optional(),
      baseUrl: z.string().optional(),
      apiKeyEnv: z.string().optional(),
      project: z.string().optional(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ file, rubric, provider, model, baseUrl, apiKeyEnv, project }) => {
    try {
      const target = existsSync(within(file)) ? within(file) : join(studioProject(project), insideProject(studioProject(project), file))
      if (!existsSync(target)) return failure(`no image at ${target}`)
      const critique = await reviewVisualAsset(target, rubric, { provider, model, baseUrl, apiKeyEnv })
      const lines = [
        `${critique.pass ? '✓' : '✗'} Visual QA (${critique.score}/10): ${critique.summary}`,
        ...(critique.issues.length ? ['Issues:', ...critique.issues.map(i => `  - ${i}`)] : []),
      ]
      return text(lines.join('\n'), { ...critique })
    } catch (error) {
      return studioFailure(error)
    }
  }))

  track('studio', server.registerTool('studio_install_godot', {
    title: 'Install Godot',
    description: `Downloads the official Godot ${GODOT_VERSION} for this computer into Engine Harness's own folder (about 60 MB), so games can be checked, played and built. Nothing is installed system-wide.`,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (extra) => {
    try {
      const existing = godotBinary()
      if (existing) return text(`Godot is already available at ${existing}.`)
      await emitProgress(extra as ToolExtra, 1, 2, `Downloading Godot ${GODOT_VERSION}...`)
      const paths = await installGodot()
      resetGodotBinary()
      await emitProgress(extra as ToolExtra, 2, 2, 'Godot installed.')
      return text(`Installed Godot ${GODOT_VERSION} at ${paths.gui}. The developer can open their game with it too (it is a normal Godot).`)
    } catch (error) {
      return studioFailure(error)
    }
  }))

  track('studio', server.registerTool('studio_export', {
    title: 'Build the game for Windows',
    description: 'Builds a Windows .exe of the game into builds/windows. The first time, Godot\'s export templates are needed (about a 1 GB download, about 200 MB kept): ask the developer, then call again with installTemplates: true.',
    inputSchema: { installTemplates: z.boolean().default(false), project: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ installTemplates, project }, extra) => {
    try {
      const dir = studioProject(project)
      if (!godotBinary()) return failure('Godot is needed to build the game: run studio_install_godot first')
      if (!hasWindowsTemplates()) {
        let confirmed = installTemplates
        if (!confirmed) {
          const decision = await elicitConfirmation(server, 'Download Godot Windows export templates (~1 GB download, ~200 MB kept on disk)?')
          if (decision === 'accepted') confirmed = true
          else if (decision === 'declined') return failure('Export cancelled: Godot export templates were not downloaded.')
          else return failure('Building needs Godot\'s export templates, a one-time download of about 1 GB (about 200 MB kept). Ask the developer, then call studio_export with installTemplates: true.')
        }
        await emitProgress(extra as ToolExtra, 1, 4, 'Downloading Godot Windows export templates...')
        await installWindowsTemplates({ onProgress: bytes => { void emitProgress(extra as ToolExtra, 1, 4, `Downloaded ${Math.round(bytes / (1024 * 1024))} MB of export templates...`) } })
      }
      const design = readDesign(dir)
      const out = join(dir, 'builds', 'windows', `${slugOf(design.title)}.exe`)
      mkdirSync(dirname(out), { recursive: true })
      await emitProgress(extra as ToolExtra, 2, 4, 'Importing project assets...')
      await godot.importProject(dir)
      await emitProgress(extra as ToolExtra, 3, 4, 'Exporting Windows executable...')
      const result = await godot.exec(dir, ['--export-release', 'Windows Desktop', out], 600_000)
      if (!existsSync(out)) return failure(`the build did not produce ${out}${result.errors.length ? `:\n${formatErrors(result.errors)}` : `\n${(result.stdout + result.stderr).split(/\r?\n/).slice(-15).join('\n')}`}`)
      await emitProgress(extra as ToolExtra, 4, 4, 'Export complete.')
      return text(`Built ${out}. The developer can double-click it, or zip the builds/windows folder to share the game.`, { exe: out })
    } catch (error) {
      return studioFailure(error)
    }
  }))
}
