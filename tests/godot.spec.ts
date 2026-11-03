import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { checkAsset } from '../src/contracts/index.ts'
import { readPng, writePngRgba } from '../src/contracts/png.ts'
import { AssetSpec } from '../src/core/model.ts'
import { Orchestrator } from '../src/core/orchestrator.ts'
import { Pools } from '../src/core/pools.ts'
import { RunStore } from '../src/core/store.ts'
import { pixelCharacterSheet, SimulatedExecutor } from '../src/executors/simulated.ts'
import { configurePixelArt, GodotBridge, parseGodotErrors, type AsyncRunner } from '../src/godot/bridge.ts'
import { findNode, parseTscn, sceneTree } from '../src/godot/tscn.ts'
import { LockManager, MemoryLockBackend } from '../src/locks/index.ts'
import { createHarnessServer } from '../src/mcp/server.ts'
import { pixelCharacterPlan } from '../src/planner/index.ts'
import { systemEnv } from '../src/setup/index.ts'
import { tempDir } from './fixtures.ts'

const SCENE = `[gd_scene load_steps=3 format=3 uid="uid://b1"]

[ext_resource type="Script" path="res://characters/hero.gd" id="1_script"]
[ext_resource type="Texture2D" path="res://art/hero.png" id="2_tex"]

[sub_resource type="RectangleShape2D" id="RectangleShape2D_feet"]
size = Vector2(10, 6)

[node name="Hero" type="CharacterBody2D"]
script = ExtResource("1_script")

[node name="Sprite" type="AnimatedSprite2D" parent="."]
position = Vector2(0, -8)

[node name="Feet" type="CollisionShape2D" parent="."]
shape = SubResource("RectangleShape2D_feet")

[node name="Health" type="Label" parent="UI"]
text = "HP: 10
of 10"

[connection signal="animation_finished" from="Sprite" to="." method="_on_animation_finished"]
`

function godotProject(scene = SCENE) {
  const project = tempDir('godot-')
  writeFileSync(join(project, 'project.godot'), 'config_version=5\n\n[application]\n\nconfig/name="Pixel RPG"\n')
  mkdirSync(join(project, 'characters'), { recursive: true })
  mkdirSync(join(project, 'art'), { recursive: true })
  writeFileSync(join(project, 'characters', 'hero.tscn'), scene)
  writeFileSync(join(project, 'characters', 'hero.gd'), 'extends CharacterBody2D\n')
  writeFileSync(join(project, 'art', 'hero.png'), pixelCharacterSheet(16, 16, 4, 6, {}))
  return project
}

describe('PNG measurement', () => {
  it('decodes RGBA and measures size, palette and alpha', () => {
    const facts = readPng(pixelCharacterSheet(16, 16, 4, 6, {}))
    expect(facts).toMatchObject({ width: 64, height: 96, colorType: 'rgba', bitDepth: 8, hardAlpha: true, empty: false })
    expect(facts.colors).toBe(4)
    expect(readPng(pixelCharacterSheet(16, 16, 4, 1, { soft: true })).hardAlpha).toBe(false)
  })

  it('counts colours of an image written with every filter type kept intact', () => {
    const rgba = new Uint8Array(3 * 2 * 4).fill(255)
    rgba.set([10, 20, 30, 255], 4)
    expect(readPng(writePngRgba(3, 2, rgba))).toMatchObject({ width: 3, height: 2, colors: 2, hardAlpha: true })
  })
})

describe('.tscn scenes', () => {
  it('parses nodes, resources, multi-line values and connections', () => {
    const scene = parseTscn(SCENE)
    expect(scene.format).toBe(3)
    expect(scene.extResources.map(resource => resource.path)).toEqual(['res://characters/hero.gd', 'res://art/hero.png'])
    expect(scene.nodes.map(node => node.name)).toEqual(['Hero', 'Sprite', 'Feet', 'Health'])
    expect(findNode(scene, 'UI/Health')!.properties.text).toBe('"HP: 10\nof 10"')
    expect(sceneTree(scene)).toBe([
      'Hero (CharacterBody2D) [characters/hero.gd]',
      '  Sprite (AnimatedSprite2D)',
      '  Feet (CollisionShape2D)',
      '    Health (Label)',
      'signal Sprite.animation_finished → Hero._on_animation_finished',
    ].join('\n'))
  })
})

describe('Godot bridge', () => {
  it('checks scripts inside the project (with its autoloads), with file and line, and removes the checker', async () => {
    const project = godotProject()
    let args: string[] = []
    const run: AsyncRunner = async (_command, given) => {
      args = given
      expect(existsSync(join(project, '.harness_check', 'check.tscn'))).toBe(true)
      return { code: 0, stdout: 'CHECK_DONE\n', stderr: 'SCRIPT ERROR: Parse Error: Expected end of statement after expression.\n   at: GDScript::reload (res://bad.gd:3)\nERROR: Failed to load script "res://bad.gd" with error "Parse error".\n', timedOut: false }
    }
    const result = await new GodotBridge({ godot: () => '/bin/godot', run }).check(project, ['res://good.gd', join(project, 'bad.gd')])
    expect(args).toEqual(['--headless', '--path', project, 'res://.harness_check/check.tscn', '--', 'res://good.gd', 'res://bad.gd'])
    expect(result.errors[0]).toEqual({ message: 'Parse Error: Expected end of statement after expression.', file: 'res://bad.gd', line: 3 })
    expect(existsSync(join(project, '.harness_check'))).toBe(false)
  })

  it('runs headless for a number of frames and reports runtime errors once', async () => {
    const output = 'Godot Engine v4.4.stable\nERROR: Node not found: "UI/Bar".\n   at: get_node (res://ui.gd:12)\nERROR: Node not found: "UI/Bar".\n   at: get_node (res://ui.gd:12)\n'
    const bridge = new GodotBridge({ godot: () => '/bin/godot', run: async (_c, args) => {
      expect(args).toEqual(['--headless', '--path', '/p', 'res://main.tscn', '--quit-after', '300'])
      return { code: 0, stdout: output, stderr: '', timedOut: false }
    } })
    const result = await bridge.runHeadless('/p', { scene: 'res://main.tscn', frames: 300 })
    expect(result.errors).toEqual([{ message: 'Node not found: "UI/Bar".', file: 'res://ui.gd', line: 12 }])
    expect(parseGodotErrors('all good')).toEqual([])
  })

  it('explains how to install Godot when it is missing', async () => {
    await expect(new GodotBridge({ godot: () => undefined }).check('/p', ['res://a.gd'])).rejects.toThrow(/godotengine.org/)
  })

  it('sets pixel-art defaults in project.godot, with a backup', () => {
    const project = godotProject()
    const steps = configurePixelArt(systemEnv(), project, { width: 320, height: 180, windowScale: 4 })
    const text = readFileSync(join(project, 'project.godot'), 'utf8')
    expect(steps[0]).toContain('backup')
    expect(text).toContain('[rendering]\n')
    expect(text).toContain('textures/canvas_textures/default_texture_filter=0')
    expect(text).toContain('window/stretch/scale_mode="integer"')
    expect(text).toContain('window/size/window_width_override=1280')
    expect(configurePixelArt(systemEnv(), project, { width: 320, height: 180, windowScale: 4 })).toEqual(['The project already uses the pixel-art settings'])
  })
})

describe('pixel-art and scene contracts', () => {
  const sheet = AssetSpec.parse({ id: 'SPR_Hero', kind: 'sprite_sheet', requires: { frameSize: [16, 16], frames: 24, maxColors: 8 } })
  const record = (dir: string, png: Buffer) => {
    mkdirSync(join(dir, 'export'), { recursive: true })
    writeFileSync(join(dir, 'export', 'hero.png'), png)
    return { id: 'SPR_Hero', kind: 'sprite_sheet' as const, files: [{ path: 'export/hero.png', role: 'export' as const }], facts: {}, provenance: { method: 'manual' as const, tool: 'aseprite', license: 'proprietary' } }
  }

  it('accepts a whole grid of frames within the palette, with hard alpha', () => {
    const dir = tempDir()
    expect(checkAsset(sheet, record(dir, pixelCharacterSheet(16, 16, 4, 6, {})), { dir }).violations).toEqual([])
  })

  it('rejects soft alpha, too few frames, a broken grid and a blown palette', () => {
    const dir = tempDir()
    const rules = (png: Buffer) => checkAsset(sheet, record(dir, png), { dir }).violations.map(v => v.rule).sort()
    expect(rules(pixelCharacterSheet(16, 16, 4, 6, { soft: true }))).toEqual(['image.alpha'])
    expect(rules(pixelCharacterSheet(16, 16, 4, 2, {}))).toEqual(['image.cells'])
    expect(rules(pixelCharacterSheet(15, 16, 4, 6, {})).includes('image.grid')).toBe(true)
    const noisy = new Uint8Array(64 * 96 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 37) % 256))
    expect(rules(writePngRgba(64, 96, noisy))).toEqual(['image.palette'])
  })

  it('checks a scene\'s root, node types, script and resources in the Godot project', () => {
    const project = godotProject()
    const spec = AssetSpec.parse({ id: 'SCN_Hero', kind: 'godot_scene', requires: { path: 'res://characters/hero.tscn', rootType: 'CharacterBody2D', nodeTypes: ['AnimatedSprite2D', 'CollisionShape2D'] } })
    const record = { id: 'SCN_Hero', kind: 'godot_scene' as const, files: [{ path: 'res://characters/hero.tscn', role: 'source' as const }], facts: {}, provenance: { method: 'manual' as const, tool: 'godot', license: 'proprietary' } }
    const ok = checkAsset(spec, record, { dir: tempDir(), projectDir: project })
    expect(ok.violations).toEqual([])
    expect(ok.record.facts).toMatchObject({ root: 'CharacterBody2D', nodes: 4, hasScript: true })
    const broken = godotProject(SCENE.replace('type="CharacterBody2D"', 'type="Node2D"').replace('res://art/hero.png', 'res://art/missing.png').replace('[node name="Feet" type="CollisionShape2D"', '[node name="Feet" type="Area2D"'))
    expect(checkAsset(spec, record, { dir: tempDir(), projectDir: broken }).violations.map(v => v.rule).sort()).toEqual(['godot.node', 'godot.resource', 'godot.root'])
    expect(checkAsset(spec, record, { dir: tempDir() }).violations.map(v => v.rule)).toContain('godot.project')
  })
})

describe('a Godot plan end to end (simulated workers)', () => {
  it('plans a pixel character, rejects soft alpha once, and writes a real scene into the project', async () => {
    const project = godotProject()
    const plan = pixelCharacterPlan({ name: 'PixelHero', description: 'a hooded hero', frameSize: [16, 16], directions: 4, animations: { idle: 2, walk: 4 }, maxColors: 16, rootType: 'CharacterBody2D', behaviour: 'moves', review: false })
    const executor = new SimulatedExecutor({ faults: true })
    const orchestrator = new Orchestrator({ plan, store: new RunStore(tempDir()), executor, pools: new Pools(), locks: new LockManager(new MemoryLockBackend()), poolOf: domain => domain, projectDir: project })
    const run = await orchestrator.runUntilIdle()
    expect(Object.values(run.tickets).map(ticket => ticket.state)).toEqual(['done', 'done', 'done'])
    expect(run.events.filter(event => event.type === 'contract.violation').map(event => event.detail.split(':')[0])).toEqual(['image.alpha'])
    expect(sceneTree(parseTscn(readFileSync(join(project, 'characters', 'pixel_hero.tscn'), 'utf8')))).toBe(
      'PixelHero (CharacterBody2D) [characters/pixel_hero.gd]\n  AnimatedSprite2D (AnimatedSprite2D)\n  CollisionShape2D (CollisionShape2D)')
  })
})

describe('Godot MCP tools', () => {
  it('reads scenes, checks scripts and runs the game through a small tool set', async () => {
    const project = godotProject()
    const run: AsyncRunner = async () => ({ code: 0, stdout: 'CHECK_DONE\n', stderr: '', timedOut: false })
    const server = createHarnessServer({ projectDir: project, godot: new GodotBridge({ godot: () => '/bin/godot', run }) })
    const client = new Client({ name: 'test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    const call = async (name: string, args: Record<string, unknown> = {}) => ((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0]!.text
    expect(await call('godot_scene', { path: 'res://characters/hero.tscn' })).toContain('  Feet (CollisionShape2D)')
    expect(await call('godot_scene', { path: 'characters/hero.tscn', node: 'Feet' })).toBe('Feet (CollisionShape2D)\nshape = SubResource("RectangleShape2D_feet")')
    expect(await call('godot_check')).toBe('✓ 1 script(s) parse cleanly.')
    expect(await call('godot_run', { seconds: 2 })).toMatch(/^Ran 2 s with no errors/)
  })
})
