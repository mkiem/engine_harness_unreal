/**
 * A stand-in Worker layer for dry runs, demos and tests: no model, no DCC. It writes plausible files and inspection facts
 * for each promised asset, and real audio, so the contract gate, locks, revisions and ingest all run for real.
 *
 * With `faults`, revision 0 makes the mistakes this pipeline exists to catch: a collision hull named for the wrong mesh,
 * a mesh exported at 100x scale, and an audio file mastered too hot (clipping peaks, loudness over the window). Revision 1 fixes what the contract reported.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writePngRgba } from '../contracts/png.ts'
import { writeWav16 } from '../contracts/wav.ts'
import type { AssetRecord, AssetSpec, Provenance, WorkerResult } from '../core/model.ts'
import type { Executor, Job } from '../core/ports.ts'

export interface SimulatedOptions {
  faults?: boolean
  /** Milliseconds each assignment takes, to make parallelism visible. */
  delayMs?: number
}

const provenance: Provenance = { method: 'simulated', tool: 'simulated-executor', license: 'proprietary' }

export class SimulatedExecutor implements Executor {
  private readonly options: SimulatedOptions
  constructor(options: SimulatedOptions = {}) {
    this.options = options
  }

  async run(job: Job): Promise<WorkerResult> {
    if (this.options.delayMs) await new Promise(resolve => setTimeout(resolve, this.options.delayMs))
    if (job.signal.aborted) return { status: 'failed', summary: 'stopped', assets: [] }
    const faulty = !!this.options.faults && job.revision === 0
    const assets = job.ticket.produces.map(spec => this.make(spec, job, faulty))
    const fixed = job.feedback.length ? ` Fixed: ${[...new Set(job.feedback.map(v => v.rule))].join(', ')}.` : ''
    return { status: 'ready', summary: `Simulated ${assets.map(asset => asset.id).join(', ')}.${fixed}`, assets }
  }

  private make(spec: AssetSpec, job: Job, faulty: boolean): AssetRecord {
    const write = (path: string, content: string | Buffer) => {
      const full = join(job.dir, path)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content)
      return path
    }
    switch (spec.kind) {
      case 'static_mesh':
      case 'skeletal_mesh': {
        const req = spec.requires
        const size = req.approxSizeCm ?? [30, 15, 20]
        const scale = faulty && spec.kind === 'static_mesh' ? 100 : 1
        const collision = req.collision === 'ucx' ? [faulty ? `UCX_${spec.id.replace(/^S[MK]_/, '')}_01` : `UCX_${spec.id}_01`] : []
        return {
          id: spec.id, kind: spec.kind, provenance: { ...provenance, recipe: 'recipe/build.py' },
          files: [
            { path: write(`export/${spec.id}.fbx`, `; simulated FBX for ${spec.id}\n`), role: 'export' },
            { path: write('recipe/build.py', `# simulated bpy recipe for ${spec.id}\n`), role: 'recipe' },
          ],
          facts: {
            triangles: Math.round(req.maxTriangles * 0.6), lods: req.lods,
            boundsCm: size.map(value => value * scale), pivotFromBaseCm: [0, 0, 0], pivotFromOriginCm: [0, 0, size[2]! / 2],
            meshNames: [spec.id, ...collision], collisionNames: collision,
            materialSlots: req.materialSlots.length ? req.materialSlots : ['MI_Default'], uvChannels: 2, transformsApplied: true,
            ...(spec.kind === 'skeletal_mesh' ? { bones: spec.requires.bones ?? 1 } : {}),
          },
        }
      }
      case 'texture_set': {
        const suffix: Record<string, string> = { BaseColor: '_BC', Normal: '_N', ORM: '_ORM', Emissive: '_E', Opacity: '_O' }
        const maps = Object.fromEntries(spec.requires.maps.map(map => [map, {
          path: write(`export/${spec.id}${suffix[map]}.png`, `simulated ${map}`), width: spec.requires.resolution, height: spec.requires.resolution,
          srgb: map === 'BaseColor' || map === 'Emissive',
        }]))
        return {
          id: spec.id, kind: spec.kind, provenance,
          files: Object.values(maps).map(map => ({ path: map.path, role: 'export' as const })),
          facts: { maps, normalConvention: spec.requires.normalConvention },
        }
      }
      case 'audio_clip': {
        const req = spec.requires
        const seconds = Math.min(req.maxSeconds, Math.max(req.minSeconds, 4))
        const samples = radioStatic(seconds, req.sampleRate, faulty ? { loop: req.loop, rmsDb: -8, peakDb: 0 } : { loop: req.loop, rmsDb: -20, peakDb: -3 })
        return {
          id: spec.id, kind: spec.kind, provenance: { ...provenance, recipe: 'recipe/synth.py' },
          files: [
            { path: write(`export/${spec.id}.wav`, writeWav16(samples, req.sampleRate)), role: 'export' },
            { path: write('recipe/synth.py', `# simulated synth recipe for ${spec.id}\n`), role: 'recipe' },
          ],
          facts: {},
        }
      }
      case 'audio_event':
        return {
          id: spec.id, kind: spec.kind, provenance,
          files: [{ path: `/Game/WwiseAudio/Events/${spec.id}`, role: 'engine' }],
          facts: { wwisePath: `\\Events\\Default Work Unit\\${spec.id}`, clip: spec.requires.clip, attenuation: spec.requires.attenuation,
            maxDistanceCm: spec.requires.maxDistanceCm, bus: spec.requires.bus, soundbankGenerated: true },
        }
      case 'blueprint':
        return {
          id: spec.id, kind: spec.kind, provenance,
          files: [{ path: `${job.plan.contentRoot}/${spec.id}`, role: 'engine' }],
          facts: { objectPath: `${job.plan.contentRoot}/${spec.id}`, parentClass: spec.requires.parentClass,
            components: spec.requires.components, interfaces: spec.requires.interfaces, compiled: true },
        }
      case 'level_placement':
        return {
          id: spec.id, kind: spec.kind, provenance,
          files: [{ path: spec.requires.map, role: 'engine' }],
          facts: { map: spec.requires.map, actorClass: spec.requires.actorClass, location: spec.requires.location, rotation: spec.requires.rotation,
            actorFile: spec.requires.oneFilePerActor ? `__ExternalActors__/${spec.requires.map.replace(/^\/Game\//, '')}/${spec.id}.uasset` : undefined },
        }
      case 'sprite_sheet': {
        const [w, h] = spec.requires.frameSize
        const columns = 4
        const rows = Math.ceil(spec.requires.frames / columns)
        const png = pixelCharacterSheet(w, h, columns, rows, { soft: faulty })
        return {
          id: spec.id, kind: spec.kind, provenance: { ...provenance, recipe: 'recipe/sprite.py' },
          files: [{ path: write(`export/${spec.id.toLowerCase()}.png`, png), role: 'export' }, { path: write('recipe/sprite.py', '# simulated sprite recipe\n'), role: 'recipe' }],
          facts: { animations: spec.requires.animations },
        }
      }
      case 'tileset': {
        const [w, h] = spec.requires.tileSize
        const columns = 8
        const rows = Math.max(1, Math.ceil(spec.requires.minTiles / columns))
        return {
          id: spec.id, kind: spec.kind, provenance,
          files: [{ path: write(`export/${spec.id.toLowerCase()}.png`, pixelCharacterSheet(w, h, columns, rows, {})), role: 'export' }],
          facts: {},
        }
      }
      case 'godot_scene': {
        if (!job.projectDir) throw new Error(`${spec.id} needs a Godot project`)
        const relative = spec.requires.path.replace(/^res:\/\//, '')
        const script = relative.replace(/\.tscn$/, '.gd')
        const write = (path: string, content: string) => {
          const full = join(job.projectDir!, path)
          mkdirSync(dirname(full), { recursive: true })
          writeFileSync(full, content)
        }
        write(script, `extends ${spec.requires.rootType}\n\n@export var speed := 60.0\n\nfunc _physics_process(_delta: float) -> void:\n\tvelocity = Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down") * speed\n\tmove_and_slide()\n`)
        const nodes = spec.requires.nodeTypes.map(type => `[node name="${type}" type="${type}" parent="."]\n`).join('\n')
        write(relative, `[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://${script}" id="1_script"]\n\n[node name="${spec.id.replace(/^SCN_/, '')}" type="${spec.requires.rootType}"]\nscript = ExtResource("1_script")\n\n${nodes}`)
        return { id: spec.id, kind: spec.kind, provenance, files: [{ path: spec.requires.path, role: 'source' }, { path: `res://${script}`, role: 'source' }], facts: {} }
      }
      case 'test_result':
        return {
          id: spec.id, kind: spec.kind, provenance,
          files: [{ path: write(`reports/${spec.id}.json`, JSON.stringify({ tests: spec.requires.tests })), role: 'report' }],
          facts: { tests: spec.requires.tests.map(name => ({ name, passed: true, message: '' })) },
        }
    }
  }
}

/**
 * Radio static: band-limited noise with crackle and a faint mains hum, normalised to an RMS level and soft-limited to a peak.
 * A loop crossfades its tail into its head, so the seam is continuous. Seeded, so the same call makes the same file.
 */
export function radioStatic(seconds: number, sampleRate: number, options: { loop?: boolean; rmsDb?: number; peakDb?: number; seed?: number } = {}): Float32Array {
  let seed = options.seed ?? 0x5eed
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000) * 2 - 1
  const length = Math.round(seconds * sampleRate)
  const fade = options.loop ? Math.min(Math.round(0.25 * sampleRate), Math.floor(length / 4)) : 0
  const raw = new Float32Array(length + fade)
  let low = 0
  let previous = 0
  let blocked = 0
  for (let i = 0; i < raw.length; i++) {
    low += 0.25 * (random() - low) // one-pole low-pass takes the hiss off the top, like a small speaker
    blocked = low - previous + 0.995 * blocked // DC blocker
    previous = low
    const crackle = random() > 0.9985 ? random() * 0.9 : 0
    const hum = 0.03 * Math.sin((2 * Math.PI * 60 * i) / sampleRate)
    raw[i] = blocked + crackle + hum
  }
  const out = raw.slice(0, length)
  for (let i = 0; i < fade; i++) {
    const t = i / fade
    out[i] = raw[i]! * t + raw[length + i]! * (1 - t) // head blends from the continuation of the tail
  }
  // Normalise to the RMS target, then soft-limit the peaks to the ceiling.
  const rms = Math.sqrt(out.reduce((sum, value) => sum + value * value, 0) / out.length) || 1
  const gain = 10 ** ((options.rmsDb ?? -20) / 20) / rms
  const ceiling = 10 ** ((options.peakDb ?? -3) / 20)
  for (let i = 0; i < out.length; i++) out[i] = ceiling * Math.tanh((out[i]! * gain) / ceiling)
  return out
}

/**
 * A placeholder pixel-art character sheet: a little hooded figure in four colours, one frame per cell, each frame nudged
 * so the animation reads. Original stand-in art for dry runs, not a game asset. `soft` adds half-transparent pixels,
 * the mistake the pixel-art contract catches.
 */
export function pixelCharacterSheet(frameW: number, frameH: number, columns: number, rows: number, options: { soft?: boolean }): Buffer {
  const width = frameW * columns
  const height = frameH * rows
  const rgba = new Uint8Array(width * height * 4)
  const palette = [[38, 43, 68], [90, 105, 136], [235, 196, 140], [194, 75, 80]] as const
  const set = (x: number, y: number, color: readonly number[], alpha = 255) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const i = (y * width + x) * 4
    rgba[i] = color[0]!; rgba[i + 1] = color[1]!; rgba[i + 2] = color[2]!; rgba[i + 3] = alpha
  }
  for (let frame = 0; frame < columns * rows; frame++) {
    const ox = (frame % columns) * frameW
    const oy = Math.floor(frame / columns) * frameH
    const bob = frame % 2
    const cx = ox + Math.floor(frameW / 2)
    for (let y = Math.floor(frameH * 0.25); y < frameH - 1; y++) {
      const half = Math.max(1, Math.floor((y - frameH * 0.2) * 0.35))
      for (let dx = -half; dx <= half; dx++) set(cx + dx, oy + y - bob, Math.abs(dx) === half ? palette[0] : palette[1])
    }
    for (let dx = -1; dx <= 1; dx++) set(cx + dx, oy + Math.floor(frameH * 0.4) - bob, palette[2])
    set(cx + (frame % 4) - 2, oy + frameH - 2, palette[3])
    if (options.soft) set(cx, oy + 1, palette[1], 128)
  }
  return writePngRgba(width, height, rgba)
}
