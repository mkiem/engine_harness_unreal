import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readPng, writePngRgba } from '../src/contracts/png.ts'
import { blenderRunner, characterPaths, CHARACTER_STYLES } from '../src/character/index.ts'
import { checkReferences, describeReport, NORMAL_HEIGHT, REFERENCE_GUIDE } from '../src/character/reference.ts'
import { sampleSheet } from '../src/character/sample.ts'
import { generateImage, readImageConfig, saveImageConfig, turnaroundPrompt } from '../src/character/imagegen.ts'
import { CHARACTER_SCRIPT, installGodotCharacter, slug } from '../src/character/godot.ts'
import { tempDir } from './fixtures.ts'

/** A white image with dark rectangles drawn on it: [x, y, w, h] in pixels. */
function drawing(width: number, height: number, rects: number[][]): Buffer {
  const rgba = new Uint8Array(width * height * 4).fill(255)
  for (const [x0, y0, w, h] of rects) {
    for (let y = y0!; y < y0! + h!; y++) for (let x = x0!; x < x0! + w!; x++) {
      if (x >= 0 && y >= 0 && x < width && y < height) rgba.set([40, 60, 120, 255], (y * width + x) * 4)
    }
  }
  return writePngRgba(width, height, rgba)
}

const figure = (cx: number, top: number, armsApart: boolean) => [
  [cx - 40, top, 80, 90], // head
  [cx - 90, top + 100, 180, 300], // torso
  ...(armsApart ? [[cx - 210, top + 140, 60, 260], [cx + 150, top + 140, 60, 260], [cx - 150, top + 110, 60, 40], [cx + 90, top + 110, 60, 40]]
    : [[cx - 150, top + 100, 60, 280], [cx + 90, top + 100, 60, 280]]), // arms
  [cx - 80, top + 400, 60, 380], [cx + 20, top + 400, 60, 380], // legs, apart
]

describe('3D character references', () => {
  it('has a guide that says which views, pose and background to use', () => {
    for (const words of ['Front (required)', 'Side (required)', 'Back', 'A-pose', 'Background', 'How many']) expect(REFERENCE_GUIDE).toContain(words)
  })

  it('accepts the sample sheet and writes normalized views', () => {
    const dir = tempDir()
    const sheet = join(dir, 'sheet.png')
    writeFileSync(sheet, sampleSheet())
    const report = checkReferences({ sheet }, join(dir, 'ref'))
    expect(report.ready).toBe(true)
    expect(Object.keys(report.views).sort()).toEqual(['back', 'front', 'side'])
    for (const view of ['front', 'side', 'back']) {
      const png = readPng(readFileSync(join(dir, 'ref', `${view}.png`)))
      expect(png.height).toBe(NORMAL_HEIGHT)
    }
    expect(report.views.front!.metrics.armsApart).toBe(true)
    expect(existsSync(join(dir, 'ref', 'references.json'))).toBe(true)
    expect(describeReport(report)).toContain('Ready to build')
  })

  it('refuses arms against the body, a cropped figure and a missing side view', () => {
    const dir = tempDir()
    const touching = join(dir, 'touching.png')
    writeFileSync(touching, drawing(700, 1000, figure(350, 60, false)))
    const side = join(dir, 'side.png')
    writeFileSync(side, drawing(400, 1000, [[150, 60, 90, 90], [140, 160, 110, 320], [150, 480, 90, 380]]))
    const pose = checkReferences({ files: { front: touching, side } }, join(dir, 'a'))
    expect(pose.ready).toBe(false)
    expect(pose.views.front!.checks.map(c => c.id)).toContain('front.pose')

    const cropped = join(dir, 'cropped.png')
    writeFileSync(cropped, drawing(700, 900, figure(350, -40, true)))
    const crop = checkReferences({ files: { front: cropped, side } }, join(dir, 'b'))
    expect(crop.views.front!.checks.map(c => c.id)).toContain('front.framing')
    expect(crop.ready).toBe(false)

    const good = join(dir, 'good.png')
    writeFileSync(good, drawing(700, 1000, figure(350, 60, true)))
    const alone = checkReferences({ files: { front: good } }, join(dir, 'c'))
    expect(alone.ready).toBe(false)
    expect(alone.checks.map(c => c.id)).toEqual(expect.arrayContaining(['views.side', 'views.back']))
    expect(alone.views.front!.metrics.armsApart).toBe(true)
  })
})

describe('image models for references', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
  const recorder = (answer: unknown) => {
    const calls: { url: string; init: any }[] = []
    const fetch = async (url: string, init: any) => {
      calls.push({ url, init })
      return { ok: true, status: 200, text: async () => '', json: async () => answer, arrayBuffer: async () => png.buffer }
    }
    return { calls, fetch }
  }

  it('asks for a turnaround sheet that follows the guide', () => {
    const prompt = turnaroundPrompt('a knight with a red cape', 'toon')
    for (const words of ['front view', 'side profile', 'back view', 'A-pose', 'white background', 'cel-shaded']) expect(prompt).toContain(words)
  })

  it('talks to OpenAI-compatible APIs, Gemini and a local Stable Diffusion', async () => {
    const env = { OPENAI_API_KEY: 'sk-test', GEMINI_API_KEY: 'g-test' }
    const openai = recorder({ data: [{ b64_json: png.toString('base64') }] })
    expect(await generateImage({ provider: 'openai', apiKeyEnv: 'OPENAI_API_KEY', baseUrl: 'http://local/v1' }, 'p', { env, fetch: openai.fetch })).toEqual(png)
    expect(openai.calls[0]!.url).toBe('http://local/v1/images/generations')
    expect(openai.calls[0]!.init.headers.Authorization).toBe('Bearer sk-test')

    const gemini = recorder({ candidates: [{ content: { parts: [{ text: 'here' }, { inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } }] })
    expect(await generateImage({ provider: 'gemini', apiKeyEnv: 'GEMINI_API_KEY', model: 'm' }, 'p', { env, fetch: gemini.fetch })).toEqual(png)
    expect(gemini.calls[0]!.url).toContain('/models/m:generateContent')
    expect(JSON.parse(gemini.calls[0]!.init.body).generationConfig.responseModalities).toEqual(['IMAGE'])

    const a1111 = recorder({ images: [png.toString('base64')] })
    expect(await generateImage({ provider: 'a1111' }, 'p', { env, fetch: a1111.fetch })).toEqual(png)
    expect(a1111.calls[0]!.url).toBe('http://127.0.0.1:7860/sdapi/v1/txt2img')

    const dir = tempDir()
    const sketch = join(dir, 'sketch.png')
    writeFileSync(sketch, sampleSheet())
    const edit = recorder({ data: [{ b64_json: png.toString('base64') }] })
    await generateImage({ provider: 'openai', apiKeyEnv: 'OPENAI_API_KEY' }, 'p', { env, fetch: edit.fetch, reference: sketch })
    expect(edit.calls[0]!.url).toBe('https://api.openai.com/v1/images/edits')
    expect(edit.calls[0]!.init.body).toBeInstanceOf(FormData)
  })

  it('needs the key in an environment variable and never stores it', async () => {
    await expect(generateImage({ provider: 'openai', apiKeyEnv: 'OPENAI_API_KEY' }, 'p', { env: {} })).rejects.toThrow(/OPENAI_API_KEY/)
    const env = { HARNESS_HOME: tempDir() }
    expect(readImageConfig(env)).toBeUndefined()
    const path = saveImageConfig({ provider: 'gemini' }, env)
    expect(readImageConfig(env)).toMatchObject({ provider: 'gemini', apiKeyEnv: 'GEMINI_API_KEY' })
    expect(readFileSync(path, 'utf8')).not.toMatch(/key"\s*:\s*"[^"]*test/)
    expect(readImageConfig({ ...env, HARNESS_IMAGE_PROVIDER: 'a1111' })!.provider).toBe('a1111')
  })
})

describe('3D character builds', () => {
  it('has at least four styles, each tied to an art style', () => {
    expect(Object.keys(CHARACTER_STYLES).length).toBeGreaterThanOrEqual(4)
    for (const style of Object.values(CHARACTER_STYLES)) expect(style.artStyle).toMatch(/^[a-z0-9-]+$/)
  })

  it('keeps each character in its own folder and finds a way to run Blender', () => {
    expect(characterPaths('/game', 'Sir Knight!').reference.replace(/\\/g, '/')).toBe('/game/characters/sir_knight/reference')
    expect(slug('Hero')).toBe('hero')
    expect(blenderRunner({ HARNESS_BLENDER_PYTHON: '/py' })).toEqual({ command: '/py', prefix: [] })
    expect(blenderRunner({}, '/blender')).toEqual({ command: '/blender', prefix: ['-b', '--factory-startup', '--python'] })
    expect(blenderRunner({})).toBeUndefined()
  })

  it('installs a built character into a Godot project', () => {
    const project = tempDir()
    writeFileSync(join(project, 'project.godot'), 'config_version=5\n')
    const build = tempDir()
    writeFileSync(join(build, 'hero.glb'), 'glb')
    const installed = installGodotCharacter(project, build, { name: 'Hero', style: 'toon', files: { glb: 'hero.glb' } })
    expect(installed.scene).toBe('res://characters/hero/Hero.tscn')
    const scene = readFileSync(join(project, 'characters', 'hero', 'Hero.tscn'), 'utf8')
    expect(scene).toContain('style = "toon"')
    expect(scene).toContain('res://characters/hero/hero.glb')
    expect(existsSync(join(project, 'characters', 'toon.gdshader'))).toBe(true)
    expect(CHARACTER_SCRIPT).toContain('CHARACTER_CHECK')
    expect(() => installGodotCharacter(project, build, { name: 'X', style: 'toon', files: {} })).toThrow(/no GLB/)
  })
})
