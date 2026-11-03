import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { readPng } from '../src/contracts/png.ts'
import { readWav } from '../src/contracts/wav.ts'
import { createHarnessServer } from '../src/mcp/server.ts'
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
    maps.town.npcs[0].dialogue = 'mayor'
    maps.town.warps[0].to = 'castle'
    writeFileSync(join(project, 'maps', 'maps.json'), JSON.stringify(maps))
    writeFileSync(join(project, 'maps', 'town.txt'), readFileSync(join(project, 'maps', 'town.txt'), 'utf8').replace('~', '%'))
    expect(checkProjectData(project)).toEqual([
      "map town uses '%', which is not in legend.json",
      'NPC elder on town says mayor, which is not in dialogue.json',
      'a warp on town leads to map castle, which is not in maps.json',
    ])
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
    expect(reports.find(r => r.id === 'art')!.checks.map(c => c.done)).toEqual([false, false, false])
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
  })
})
