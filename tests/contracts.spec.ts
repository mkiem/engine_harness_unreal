import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkAsset, checkDelivery } from '../src/contracts/index.ts'
import { parseCollisionName } from '../src/contracts/naming.ts'
import { readWav, writeWav16 } from '../src/contracts/wav.ts'
import { AssetSpec, type AssetRecord } from '../src/core/model.ts'
import { radioStatic } from '../src/executors/simulated.ts'
import { radioPlan, tempDir } from './fixtures.ts'

const meshSpec = AssetSpec.parse({ id: 'SM_Radio', kind: 'static_mesh', requires: { maxTriangles: 5000, lods: 2, approxSizeCm: [40, 22, 28], materialSlots: ['MI_Radio'] } })

function meshRecord(dir: string, facts: Record<string, unknown> = {}): AssetRecord {
  mkdirSync(join(dir, 'export'), { recursive: true })
  writeFileSync(join(dir, 'export/SM_Radio.fbx'), 'fbx')
  return {
    id: 'SM_Radio', kind: 'static_mesh', files: [{ path: 'export/SM_Radio.fbx', role: 'export' }],
    provenance: { method: 'manual', tool: 'blender', license: 'proprietary' },
    facts: { triangles: 4000, lods: 2, boundsCm: [41, 22, 27], pivotFromBaseCm: [0, 0, 0], pivotFromOriginCm: [0, 0, 14],
      meshNames: ['SM_Radio', 'UCX_SM_Radio_01'], collisionNames: ['UCX_SM_Radio_01'], materialSlots: ['MI_Radio'], uvChannels: 2, transformsApplied: true, ...facts },
  }
}
const rules = (violations: { rule: string }[]) => violations.map(v => v.rule).sort()

describe('naming', () => {
  it('parses collision names and rejects near misses', () => {
    expect(parseCollisionName('UCX_SM_Radio_01')).toEqual({ type: 'UCX', mesh: 'SM_Radio', index: 1 })
    expect(parseCollisionName('UCX_SM_Radio')).toBeUndefined()
    expect(parseCollisionName('ucx_SM_Radio_01')).toBeUndefined()
  })
})

describe('static mesh contract', () => {
  it('accepts a mesh that meets its spec and records file hashes', () => {
    const dir = tempDir()
    const { violations, record } = checkAsset(meshSpec, meshRecord(dir), { dir })
    expect(violations).toEqual([])
    expect(record.files[0]!.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('catches the classic interchange mistakes, each with its own rule', () => {
    const dir = tempDir()
    const { violations } = checkAsset(meshSpec, meshRecord(dir, {
      triangles: 9000, boundsCm: [4000, 2200, 2800], pivotFromBaseCm: [0, 0, 14], transformsApplied: false,
      collisionNames: ['UCX_Radio_01'], meshNames: ['SM_Radio', 'UCX_Radio_01'], materialSlots: ['Material.001'],
    }), { dir })
    expect(rules(violations)).toEqual(['collision.target', 'mesh.materials', 'mesh.pivot', 'mesh.size', 'mesh.size', 'mesh.size', 'mesh.transforms', 'mesh.triangles'])
    expect(violations.find(v => v.rule === 'mesh.size')!.message).toContain('100x too large')
  })

  it('requires collision when the spec asks for UCX', () => {
    const dir = tempDir()
    expect(rules(checkAsset(meshSpec, meshRecord(dir, { collisionNames: [], meshNames: ['SM_Radio'] }), { dir }).violations)).toEqual(['collision.missing'])
  })

  it('reports incomplete facts instead of guessing', () => {
    const dir = tempDir()
    const record = { ...meshRecord(dir), facts: { triangles: 10 } }
    expect(rules(checkAsset(meshSpec, record, { dir }).violations)).toEqual(['facts.invalid'])
  })

  it('refuses files outside the ticket directory and missing files', () => {
    const dir = tempDir()
    const record = meshRecord(dir)
    record.files = [{ path: '../../etc/passwd', role: 'export' }, { path: 'export/missing.fbx', role: 'source' }]
    expect(rules(checkAsset(meshSpec, record, { dir }).violations)).toEqual(['file.export', 'file.missing', 'file.outside'])
  })

  it('requires a recipe for procedural assets', () => {
    const dir = tempDir()
    const record = { ...meshRecord(dir), provenance: { method: 'procedural' as const, tool: 'bpy', license: 'proprietary' } }
    expect(rules(checkAsset(meshSpec, record, { dir }).violations)).toEqual(['provenance.recipe'])
  })
})

describe('audio contract', () => {
  const spec = AssetSpec.parse({ id: 'SFX_Static', kind: 'audio_clip', requires: { loop: true, minSeconds: 1 } })
  const record = (dir: string, samples: Float32Array, rate = 48000): AssetRecord => {
    mkdirSync(join(dir, 'export'), { recursive: true })
    writeFileSync(join(dir, 'export/SFX_Static.wav'), writeWav16(samples, rate))
    return { id: 'SFX_Static', kind: 'audio_clip', files: [{ path: 'export/SFX_Static.wav', role: 'export' }], facts: {}, provenance: { method: 'procedural', tool: 'synth', recipe: 'recipe/synth.py', license: 'proprietary' } }
  }

  it('measures the WAV itself and merges the measurements into the facts', () => {
    const dir = tempDir()
    const { violations, record: checked } = checkAsset(spec, record(dir, radioStatic(2, 48000, { loop: true })), { dir })
    expect(violations).toEqual([])
    expect(checked.facts.sampleRate).toBe(48000)
    expect(checked.facts.seconds).toBeCloseTo(2, 3)
  })

  it('rejects hot masters, wrong rates and clicking loops', () => {
    const dir = tempDir()
    const hot = radioStatic(2, 44100, { rmsDb: -6, peakDb: 0 })
    hot[hot.length - 1] = 0.9
    hot[0] = -0.9
    expect(rules(checkAsset(spec, record(dir, hot, 44100), { dir }).violations)).toEqual(['audio.loop-seam', 'audio.loudness', 'audio.peak', 'audio.rate'])
  })

  it('reads PCM headers', () => {
    const facts = readWav(writeWav16(new Float32Array([0, 0.5, -0.5, 0]), 8000))
    expect(facts).toMatchObject({ format: 'pcm', sampleRate: 8000, channels: 1, bitDepth: 16, frames: 4 })
    expect(facts.peakDb).toBeCloseTo(-6.02, 1)
  })
})

describe('delivery', () => {
  it('flags missing and unpromised assets', () => {
    const plan = radioPlan()
    const ticket = plan.tickets.find(t => t.id === 'vintage-radio-audio')!
    const dir = tempDir()
    const result = { status: 'ready' as const, summary: '', assets: [{ id: 'SM_Other', kind: 'static_mesh' as const, files: [{ path: 'x', role: 'export' as const }], facts: {}, provenance: { method: 'manual' as const, tool: 'x', license: 'x' } }] }
    expect(rules(checkDelivery(ticket, result, { dir }).violations)).toEqual(['delivery.missing', 'delivery.missing', 'delivery.unpromised'])
  })
})
