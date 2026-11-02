/**
 * The asset contract: the deterministic gate between tickets. A worker's `ready` report is a claim; this module checks it
 * against the spec the plan promised, using measured facts and the files themselves, before any consumer may start.
 *
 * Every check returns Violations with a stable `rule` code, so a revision request tells the worker exactly what to fix
 * and the same failure is recognisable across revisions.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'
import type { AssetRecord, AssetSpec, SpecOf, TicketSpec, Violation, WorkerResult } from '../core/model.ts'
import { looksLikeCollision, parseCollisionName, prefixProblem, TEXTURE_SUFFIX } from './naming.ts'
import { readWav } from './wav.ts'
import { readPng } from './png.ts'
import { parseTscn, resourcePaths } from '../godot/tscn.ts'

export interface ContractContext {
  /** The ticket's directory; relative asset paths resolve against it and may not leave it. */
  dir: string
  /** The Godot project (the folder holding project.godot), where res:// paths resolve. */
  projectDir?: string
}

const resPath = (project: string, res: string) => resolve(project, res.replace(/^res:\/\//, ''))

export interface CheckedDelivery {
  violations: Violation[]
  /** The records with file hashes filled in and, for audio, the measured facts merged over the reported ones. */
  assets: AssetRecord[]
}

const Vec3 = z.tuple([z.number(), z.number(), z.number()])

/** Facts the Blender inspection script (dcc/blender/inspect_export.py) writes for a mesh export. */
export const MeshFacts = z.object({
  triangles: z.number().int().nonnegative(),
  lods: z.number().int().min(1),
  boundsCm: Vec3,
  /** Pivot position relative to the bottom centre of the bounds. */
  pivotFromBaseCm: Vec3,
  /** Pivot position relative to the world origin. */
  pivotFromOriginCm: Vec3,
  meshNames: z.array(z.string()),
  collisionNames: z.array(z.string()),
  materialSlots: z.array(z.string()),
  uvChannels: z.number().int().nonnegative(),
  /** Rotation zero and scale one on every exported object: unapplied transforms import rotated or scaled. */
  transformsApplied: z.boolean(),
  bones: z.number().int().nonnegative().optional(),
})

const TextureMapFacts = z.object({ path: z.string(), width: z.number().int(), height: z.number().int(), srgb: z.boolean() })
export const TextureFacts = z.object({
  maps: z.record(z.string(), TextureMapFacts),
  normalConvention: z.enum(['directx', 'opengl']).optional(),
})

export const AudioEventFacts = z.object({
  wwisePath: z.string(),
  clip: z.string(),
  attenuation: z.string().optional(),
  maxDistanceCm: z.number().optional(),
  bus: z.string().optional(),
  soundbankGenerated: z.boolean(),
})

export const BlueprintFacts = z.object({
  objectPath: z.string(),
  parentClass: z.string(),
  components: z.array(z.string()),
  interfaces: z.array(z.string()),
  compiled: z.boolean(),
})

export const PlacementFacts = z.object({
  map: z.string(),
  actorClass: z.string(),
  location: Vec3,
  rotation: Vec3.optional(),
  /** The external actor file under __ExternalActors__, for maps with One File Per Actor. */
  actorFile: z.string().optional(),
})

export const TestFacts = z.object({
  tests: z.array(z.object({ name: z.string(), passed: z.boolean(), message: z.string().default('') })),
})

const MESH_EXPORTS = new Set(['.fbx', '.glb', '.gltf'])

/** Checks a worker's result against the ticket's promises: every promised asset, nothing unpromised, each by its contract. */
export function checkDelivery(ticket: TicketSpec, result: WorkerResult, ctx: ContractContext): CheckedDelivery {
  const violations: Violation[] = []
  const assets: AssetRecord[] = []
  const promised = new Map(ticket.produces.map(spec => [spec.id, spec]))
  for (const record of result.assets) {
    const spec = promised.get(record.id)
    if (!spec) {
      violations.push({ asset: record.id, rule: 'delivery.unpromised', message: `${record.id} is not one of this ticket's assets (${[...promised.keys()].join(', ') || 'none'})` })
      continue
    }
    const checked = checkAsset(spec, record, ctx)
    violations.push(...checked.violations)
    assets.push(checked.record)
  }
  for (const id of promised.keys()) {
    if (!result.assets.some(record => record.id === id))
      violations.push({ asset: id, rule: 'delivery.missing', message: `${id} was promised but not delivered` })
  }
  return { violations, assets }
}

export function checkAsset(spec: AssetSpec, record: AssetRecord, ctx: ContractContext): { violations: Violation[]; record: AssetRecord } {
  const out: Violation[] = []
  const fail = (rule: string, message: string) => out.push({ asset: spec.id, rule, message })
  if (record.kind !== spec.kind) {
    fail('kind.mismatch', `${spec.id} was promised as ${spec.kind} but delivered as ${record.kind}`)
    return { violations: out, record }
  }
  const prefix = prefixProblem(spec.kind, spec.id)
  if (prefix) fail('naming.prefix', prefix)

  const files = record.files.map(file => {
    if (file.path.startsWith('res://')) {
      if (!ctx.projectDir) fail('godot.project', `${file.path} is a Godot path, but no Godot project is open`)
      else if (!existsSync(resPath(ctx.projectDir, file.path))) fail('file.missing', `${file.path} does not exist in the Godot project`)
      return file
    }
    if (file.role === 'engine') {
      if (!file.path.startsWith('/Game/')) fail('file.engine-path', `${file.path} must be a /Game/ object path or a res:// path`)
      return file
    }
    const path = isAbsolute(file.path) ? file.path : resolve(ctx.dir, file.path)
    const rel = relative(ctx.dir, path)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      fail('file.outside', `${file.path} is outside the ticket directory`)
      return file
    }
    if (!existsSync(path) || !statSync(path).isFile()) {
      fail('file.missing', `${file.path} does not exist`)
      return file
    }
    const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
    if (file.sha256 && file.sha256 !== sha256) fail('file.hash', `${file.path} changed after it was reported`)
    return { ...file, sha256 }
  })
  let checked: AssetRecord = { ...record, files }

  if (record.provenance.method === 'procedural' && !record.provenance.recipe)
    fail('provenance.recipe', `${spec.id} is procedural but names no recipe script to reproduce it`)
  if (record.provenance.method === 'generative' && !record.provenance.model)
    fail('provenance.model', `${spec.id} is generative but names no model or service`)

  const exportFile = (extensions: Set<string>) => files.find(file => file.role === 'export' && extensions.has(extname(file.path).toLowerCase()))
  const facts = <T>(schema: z.ZodType<T>): T | undefined => {
    const parsed = schema.safeParse(record.facts)
    if (parsed.success) return parsed.data
    fail('facts.invalid', `${spec.id} facts are incomplete: ${parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'} ${issue.message}`).join('; ')}`)
    return undefined
  }

  switch (spec.kind) {
    case 'static_mesh':
    case 'skeletal_mesh': {
      if (!exportFile(MESH_EXPORTS)) fail('file.export', `${spec.id} has no .fbx, .glb or .gltf export file`)
      const mesh = facts(MeshFacts)
      if (mesh) checkMesh(spec, mesh, fail)
      break
    }
    case 'texture_set': {
      const texture = facts(TextureFacts)
      if (texture) checkTexture(spec, texture, fail)
      break
    }
    case 'audio_clip': {
      const file = exportFile(new Set(['.wav']))
      if (!file) {
        fail('file.export', `${spec.id} has no .wav export file`)
        break
      }
      try {
        const measured = readWav(readFileSync(resolve(ctx.dir, file.path)))
        checkAudio(spec, measured, fail)
        checked = { ...checked, facts: { ...record.facts, ...measured } }
      } catch (error) {
        fail('audio.unreadable', `${file.path}: ${(error as Error).message}`)
      }
      break
    }
    case 'audio_event': {
      const event = facts(AudioEventFacts)
      if (!event) break
      if (event.clip !== spec.requires.clip) fail('audio.event-clip', `${spec.id} plays ${event.clip}, not ${spec.requires.clip}`)
      if (spec.requires.attenuation && event.attenuation !== spec.requires.attenuation)
        fail('audio.attenuation', `${spec.id} uses attenuation ${event.attenuation ?? 'none'}, not ${spec.requires.attenuation}`)
      if (spec.requires.maxDistanceCm && event.maxDistanceCm !== undefined && Math.abs(event.maxDistanceCm - spec.requires.maxDistanceCm) > 1)
        fail('audio.distance', `${spec.id} max distance is ${event.maxDistanceCm} cm, not ${spec.requires.maxDistanceCm} cm`)
      if (!event.soundbankGenerated) fail('audio.soundbank', `${spec.id} was not included in a generated SoundBank`)
      break
    }
    case 'blueprint': {
      const bp = facts(BlueprintFacts)
      if (!bp) break
      if (!bp.compiled) fail('blueprint.compile', `${spec.id} does not compile`)
      if (bp.parentClass !== spec.requires.parentClass) fail('blueprint.parent', `${spec.id} derives from ${bp.parentClass}, not ${spec.requires.parentClass}`)
      for (const component of spec.requires.components)
        if (!bp.components.includes(component)) fail('blueprint.component', `${spec.id} has no ${component}`)
      for (const iface of spec.requires.interfaces)
        if (!bp.interfaces.includes(iface)) fail('blueprint.interface', `${spec.id} does not implement ${iface}`)
      break
    }
    case 'level_placement': {
      const placed = facts(PlacementFacts)
      if (!placed) break
      if (placed.map !== spec.requires.map) fail('placement.map', `${spec.id} is in ${placed.map}, not ${spec.requires.map}`)
      if (placed.actorClass !== spec.requires.actorClass) fail('placement.class', `${spec.id} spawns ${placed.actorClass}, not ${spec.requires.actorClass}`)
      const off = Math.max(...placed.location.map((value, axis) => Math.abs(value - spec.requires.location[axis]!)))
      if (off > 1) fail('placement.location', `${spec.id} is ${off.toFixed(1)} cm from its target location`)
      if (spec.requires.oneFilePerActor && !placed.actorFile) fail('placement.ofpa', `${spec.id} has no external actor file; the map must use One File Per Actor`)
      break
    }
    case 'sprite_sheet':
    case 'tileset': {
      const file = files.find(item => item.role === 'export' && extname(item.path).toLowerCase() === '.png')
      if (!file) {
        fail('file.export', `${spec.id} has no .png export file`)
        break
      }
      const path = file.path.startsWith('res://') && ctx.projectDir ? resPath(ctx.projectDir, file.path) : resolve(ctx.dir, file.path)
      try {
        const png = readPng(readFileSync(path), spec.requires.maxColors)
        checkPixelArt(spec, png, fail)
        checked = { ...checked, facts: { ...record.facts, ...png } }
      } catch (error) {
        fail('image.unreadable', `${file.path}: ${(error as Error).message}`)
      }
      break
    }
    case 'godot_scene': {
      if (!ctx.projectDir) {
        fail('godot.project', `${spec.id} is a Godot scene, but no Godot project is open`)
        break
      }
      const path = resPath(ctx.projectDir, spec.requires.path)
      if (!existsSync(path)) {
        fail('file.missing', `${spec.requires.path} does not exist`)
        break
      }
      const scene = parseTscn(readFileSync(path, 'utf8'))
      const root = scene.nodes.find(node => node.parent === undefined)
      if (!root) fail('godot.root', `${spec.requires.path} has no root node`)
      else if (root.type !== spec.requires.rootType) fail('godot.root', `${spec.requires.path} root is ${root.type ?? 'an instance'}, not ${spec.requires.rootType}`)
      const types = new Set(scene.nodes.map(node => node.type).filter(Boolean))
      for (const type of spec.requires.nodeTypes) if (!types.has(type)) fail('godot.node', `${spec.requires.path} has no ${type} node`)
      if (spec.requires.script && root && !root.properties.script) fail('godot.script', `${spec.requires.path} root has no script attached`)
      for (const res of resourcePaths(scene)) if (!existsSync(resPath(ctx.projectDir, res))) fail('godot.resource', `${spec.requires.path} uses ${res}, which does not exist`)
      checked = { ...checked, facts: { ...record.facts, root: root?.type, nodes: scene.nodes.length, nodeTypes: [...types], resources: resourcePaths(scene), hasScript: !!root?.properties.script } }
      break
    }
    case 'test_result': {
      const result = facts(TestFacts)
      if (!result) break
      for (const name of spec.requires.tests) {
        const test = result.tests.find(item => item.name === name)
        if (!test) fail('test.missing', `${name} did not run`)
        else if (!test.passed) fail('test.failed', `${name} failed${test.message ? `: ${test.message}` : ''}`)
      }
      break
    }
  }
  return { violations: out, record: checked }
}

type Fail = (rule: string, message: string) => void

function checkMesh(spec: SpecOf<'static_mesh'> | SpecOf<'skeletal_mesh'>, mesh: z.infer<typeof MeshFacts>, fail: Fail): void {
  const req = spec.requires
  if (mesh.triangles > req.maxTriangles) fail('mesh.triangles', `${spec.id} LOD0 has ${mesh.triangles} triangles, over the budget of ${req.maxTriangles}`)
  if (mesh.lods < req.lods) fail('mesh.lods', `${spec.id} has ${mesh.lods} LODs, ${req.lods} required`)
  if (!mesh.transformsApplied) fail('mesh.transforms', `${spec.id} has unapplied rotation or scale; apply transforms before export`)
  if (mesh.uvChannels < 1) fail('mesh.uv', `${spec.id} has no UV channel`)
  if (!mesh.meshNames.includes(spec.id) && !mesh.meshNames.some(name => name.startsWith(`${spec.id}_LOD`)))
    fail('naming.mesh', `the export has no render mesh named ${spec.id} (found ${mesh.meshNames.join(', ') || 'none'})`)

  if (req.collision === 'ucx') {
    if (!mesh.collisionNames.length) fail('collision.missing', `${spec.id} has no custom collision; add UCX_${spec.id}_01`)
    for (const name of mesh.collisionNames) {
      const parsed = parseCollisionName(name)
      if (!parsed) fail('collision.name', `${name} is not <UCX|UBX|USP|UCP>_${spec.id}_NN; the importer would treat it as render geometry`)
      else if (parsed.mesh !== spec.id) fail('collision.target', `${name} names mesh ${parsed.mesh}, not ${spec.id}; it would import as render geometry`)
    }
  } else if (mesh.collisionNames.length) {
    fail('collision.unexpected', `${spec.id} asks for ${req.collision} collision but exports ${mesh.collisionNames.join(', ')}`)
  }
  for (const name of mesh.meshNames)
    if (looksLikeCollision(name) && !parseCollisionName(name)) fail('collision.name', `${name} looks like collision but does not follow <UCX|UBX|USP|UCP>_${spec.id}_NN`)

  const pivot = req.pivot === 'base' ? mesh.pivotFromBaseCm : mesh.pivotFromOriginCm
  const pivotOff = Math.hypot(...pivot)
  if (pivotOff > 0.5) fail('mesh.pivot', `${spec.id} pivot is ${pivotOff.toFixed(2)} cm from its ${req.pivot === 'base' ? 'bottom centre' : 'world origin'}`)

  if (req.approxSizeCm) {
    req.approxSizeCm.forEach((expected, axis) => {
      const actual = mesh.boundsCm[axis]!
      const ratio = actual / expected
      if (Math.abs(ratio - 1) <= req.sizeTolerance) return
      const hint = ratio > 50 && ratio < 200 ? ' (100x too large: check the unit scale on export)'
        : ratio > 0.005 && ratio < 0.02 ? ' (100x too small: check the unit scale on export)' : ''
      fail('mesh.size', `${spec.id} is ${actual.toFixed(1)} cm along ${'XYZ'[axis]}, expected about ${expected} cm${hint}`)
    })
  }
  const slots = req.materialSlots
  if (slots.length && slots.some((slot, index) => mesh.materialSlots[index] !== slot))
    fail('mesh.materials', `${spec.id} material slots are [${mesh.materialSlots.join(', ')}], expected [${slots.join(', ')}]`)
  if (spec.kind === 'skeletal_mesh' && spec.requires.bones && (mesh.bones ?? 0) < spec.requires.bones)
    fail('mesh.bones', `${spec.id} has ${mesh.bones ?? 0} bones, ${spec.requires.bones} required`)
}

function checkPixelArt(spec: SpecOf<'sprite_sheet'> | SpecOf<'tileset'>, png: ReturnType<typeof readPng>, fail: Fail): void {
  const [cellW, cellH] = spec.kind === 'sprite_sheet' ? spec.requires.frameSize : spec.requires.tileSize
  const unit = spec.kind === 'sprite_sheet' ? 'frame' : 'tile'
  if (png.bitDepth !== 8 || png.interlaced) fail('image.format', `${spec.id} must be an 8-bit, non-interlaced PNG`)
  if (png.width % cellW || png.height % cellH) fail('image.grid', `${spec.id} is ${png.width}x${png.height}, not a whole grid of ${cellW}x${cellH} ${unit}s`)
  const cells = Math.floor(png.width / cellW) * Math.floor(png.height / cellH)
  const needed = spec.kind === 'sprite_sheet' ? spec.requires.frames : spec.requires.minTiles
  if (cells < needed) fail('image.cells', `${spec.id} holds ${cells} ${unit}s, ${needed} required`)
  if (png.empty) fail('image.empty', `${spec.id} has no visible pixels`)
  if (png.colors > spec.requires.maxColors) fail('image.palette', `${spec.id} uses ${png.colors > spec.requires.maxColors ? `more than ${spec.requires.maxColors}` : png.colors} colours; the palette budget is ${spec.requires.maxColors}`)
  if (spec.requires.hardAlpha && !png.hardAlpha) fail('image.alpha', `${spec.id} has semi-transparent pixels; pixel art needs fully opaque or fully transparent pixels`)
}

function checkTexture(spec: SpecOf<'texture_set'>, texture: z.infer<typeof TextureFacts>, fail: Fail): void {
  for (const map of spec.requires.maps) {
    const found = texture.maps[map]
    const expectedName = `${spec.id}${TEXTURE_SUFFIX[map]}`
    if (!found) {
      fail('texture.missing', `${spec.id} has no ${map} map (${expectedName})`)
      continue
    }
    if (!found.path.includes(expectedName)) fail('naming.texture', `${map} map ${found.path} should be named ${expectedName}`)
    if (found.width !== spec.requires.resolution || found.height !== spec.requires.resolution)
      fail('texture.resolution', `${expectedName} is ${found.width}x${found.height}, expected ${spec.requires.resolution}x${spec.requires.resolution}`)
    // Colour maps are sRGB; data maps (normal, packed ORM) must be linear or the shading is wrong.
    const wantSrgb = map === 'BaseColor' || map === 'Emissive'
    if (found.srgb !== wantSrgb) fail('texture.srgb', `${expectedName} must be ${wantSrgb ? 'sRGB' : 'linear'}`)
  }
  if (spec.requires.maps.includes('Normal') && texture.normalConvention && texture.normalConvention !== spec.requires.normalConvention)
    fail('texture.normal', `${spec.id} normal map is ${texture.normalConvention}; Unreal expects ${spec.requires.normalConvention}`)
}

function checkAudio(spec: SpecOf<'audio_clip'>, wav: ReturnType<typeof readWav>, fail: Fail): void {
  const req = spec.requires
  if (wav.format !== 'pcm') fail('audio.format', `${spec.id} is ${wav.format}; Wwise import expects PCM`)
  if (wav.sampleRate !== req.sampleRate) fail('audio.rate', `${spec.id} is ${wav.sampleRate} Hz, expected ${req.sampleRate} Hz`)
  if (wav.channels !== req.channels) fail('audio.channels', `${spec.id} has ${wav.channels} channels, expected ${req.channels}`)
  if (wav.bitDepth !== req.bitDepth) fail('audio.bits', `${spec.id} is ${wav.bitDepth}-bit, expected ${req.bitDepth}-bit`)
  if (wav.seconds < req.minSeconds || wav.seconds > req.maxSeconds)
    fail('audio.length', `${spec.id} is ${wav.seconds.toFixed(2)} s, expected ${req.minSeconds}–${req.maxSeconds} s`)
  if (wav.peakDb > req.maxPeakDb) fail('audio.peak', `${spec.id} peaks at ${wav.peakDb.toFixed(1)} dBFS, above ${req.maxPeakDb} dBFS`)
  const [low, high] = req.loudnessDb
  if (wav.rmsDb < low || wav.rmsDb > high) fail('audio.loudness', `${spec.id} RMS is ${wav.rmsDb.toFixed(1)} dBFS, expected ${low} to ${high}`)
  if (req.loop && wav.loopSeam > 0.05) fail('audio.loop-seam', `${spec.id} loops with a jump of ${wav.loopSeam.toFixed(3)} full scale at the seam (an audible click)`)
}
