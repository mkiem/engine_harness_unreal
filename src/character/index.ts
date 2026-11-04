/**
 * 3D characters from reference images, for Unreal and Godot: where a character's files live, the four styles, running
 * the Blender build (dcc/blender/character/build_character.py) and checking what it made against the asset
 * contracts: the skeletal mesh (SK_<Name>, triangle budget, bones, applied transforms, UVs) and its texture set
 * (T_<Name>_BC, _N, _ORM).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { checkAsset } from '../contracts/index.ts'
import { readPng } from '../contracts/png.ts'
import { AssetSpec } from '../core/model.ts'
import { slug } from './godot.ts'

export const CHARACTER_STYLES = {
  voxel: { name: 'Voxel', about: 'Built from visible cubes, like Minecraft-style or Teardown characters. Crisp, chunky, very readable; a small palette.', artStyle: 'voxel-worlds', triangles: 12000 },
  lowpoly: { name: 'Low-poly', about: 'Faceted, flat-shaded shapes with a small palette, like many indie 3D games. About 1,400 triangles.', artStyle: 'faceted-low-poly', triangles: 1400 },
  toon: { name: 'Toon', about: 'Smooth shapes with cel shading and an ink outline (in Godot; in Unreal, use a toon material), anime or cartoon style. About 9,000 triangles.', artStyle: 'anime-cel-3d', triangles: 9000 },
  retro: { name: 'Retro 3D', about: 'Very few polygons and a tiny, crisp texture, like 1990s 3D consoles (PS1 era). About 800 triangles.', artStyle: 'low-resolution-3d', triangles: 800 },
} as const
export type CharacterStyle = keyof typeof CHARACTER_STYLES

export interface CharacterPaths { dir: string; reference: string; build: string }
export function characterPaths(root: string, name: string): CharacterPaths {
  const dir = join(root, 'characters', slug(name))
  return { dir, reference: join(dir, 'reference'), build: join(dir, 'build') }
}

export interface BlenderRunner { command: string; prefix: string[] }

/**
 * How to run a Blender script: HARNESS_BLENDER_PYTHON (a Python that can `import bpy`, as in CI) or a Blender
 * executable in background mode.
 */
export function blenderRunner(env: NodeJS.ProcessEnv, blender?: string): BlenderRunner | undefined {
  if (env.HARNESS_BLENDER_PYTHON) return { command: env.HARNESS_BLENDER_PYTHON, prefix: [] }
  if (blender) return { command: blender, prefix: ['-b', '--factory-startup', '--python'] }
  return undefined
}

export function runBlender(runner: BlenderRunner, script: string, args: string[], timeoutMs = 900_000): Promise<{ code: number | null; output: string }> {
  return new Promise(done => {
    const child = spawn(runner.command, [...runner.prefix, script, '--', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('error', error => { clearTimeout(timer); done({ code: null, output: output + String(error) }) })
    child.on('close', code => { clearTimeout(timer); done({ code, output }) })
  })
}

export interface BuildReport {
  name: string; asset: string; style: CharacterStyle; engine: string; heightM: number; triangles: number; vertices: number
  bones: number; boneNames: string[]; animations: string[]; dimensionsM: number[]
  textures: Record<'BC' | 'ORM' | 'N', string>; files: { fbx?: string; glb?: string }; blend: string; preview: string; views: string[]
}

export interface Built { report: BuildReport; dir: string; violations: { asset: string; rule: string; message: string }[]; facts: Record<string, unknown> }

/** Builds the character and checks it; throws with Blender's last lines when the build fails. */
export async function buildCharacter(runner: BlenderRunner, dccDir: string, options: {
  name: string; style: CharacterStyle; reference: string; out: string; engine: 'unreal' | 'godot' | 'both'
  height?: number; triangles?: number; sideFacing?: 'right' | 'left'
}): Promise<Built> {
  if (!existsSync(join(options.reference, 'front.png')) || !existsSync(join(options.reference, 'side.png'))) {
    throw new Error('no checked references yet: run character_check_references (or character_generate_references) first')
  }
  mkdirSync(options.out, { recursive: true })
  const args = ['--refs', options.reference, '--name', options.name, '--style', options.style, '--out', options.out, '--engine', options.engine,
    '--height', String(options.height ?? 1.8), '--side-facing', options.sideFacing ?? 'right']
  if (options.triangles) args.push('--triangles', String(options.triangles))
  const run = await runBlender(runner, resolve(dccDir, 'blender', 'character', 'build_character.py'), args)
  const line = run.output.split(/\r?\n/).find(l => l.startsWith('CHARACTER_BUILT '))
  if (!line) throw new Error(`the Blender build failed (exit ${run.code}):\n${run.output.split(/\r?\n/).filter(l => l.trim() && !/^Fra:|^\s+Time/.test(l)).slice(-20).join('\n')}`)
  const report = JSON.parse(line.slice('CHARACTER_BUILT '.length)) as BuildReport

  // Measure the export the engine will read, then hold mesh and textures to their contracts.
  const exported = report.files.fbx ?? report.files.glb!
  const factsPath = join(options.out, 'facts.json')
  await runBlender(runner, resolve(dccDir, 'blender', 'inspect_export.py'), [join(options.out, exported), factsPath, '--asset', report.asset], 300_000)
  const facts = existsSync(factsPath) ? JSON.parse(readFileSync(factsPath, 'utf8')) : {}
  const provenance = { method: 'procedural' as const, tool: 'blender (build_character.py)', recipe: 'dcc/blender/character/build_character.py', license: 'proprietary' }
  const meshSpec = AssetSpec.parse({ id: report.asset, kind: 'skeletal_mesh', description: `${report.name}, ${report.style}`,
    requires: { maxTriangles: Math.max(options.triangles ?? 0, CHARACTER_STYLES[options.style].triangles), lods: 1, collision: 'none', pivot: 'base', bones: 20,
      approxSizeCm: [Math.max(10, report.dimensionsM[0]! * 100), Math.max(10, report.dimensionsM[1]! * 100), (options.height ?? 1.8) * 100] } })
  const mesh = checkAsset(meshSpec, { id: report.asset, kind: 'skeletal_mesh', files: [{ path: exported, role: 'export' }], facts, provenance }, { dir: options.out })
  const textureId = `T_${report.name}`
  const map = (key: 'BC' | 'ORM' | 'N', srgb: boolean) => {
    const path = join(options.out, report.textures[key])
    const png = readPng(readFileSync(path))
    return { path: report.textures[key], width: png.width, height: png.height, srgb }
  }
  const size = map('BC', true).width
  const textureSpec = AssetSpec.parse({ id: textureId, kind: 'texture_set', requires: { resolution: size, maps: ['BaseColor', 'Normal', 'ORM'], normalConvention: 'directx' } })
  const textureFacts = { maps: { BaseColor: map('BC', true), Normal: map('N', false), ORM: map('ORM', false) }, normalConvention: 'directx' }
  const textures = checkAsset(textureSpec, { id: textureId, kind: 'texture_set', files: Object.values(report.textures).map(path => ({ path, role: 'export' as const })), facts: textureFacts, provenance }, { dir: options.out })
  // The width and depth come from the silhouettes, so only the height is a requirement; the size rule checks all three.
  const violations = [...mesh.violations, ...textures.violations].filter(v => v.rule !== 'mesh.size' || /along Z|height/i.test(v.message))
  return { report, dir: options.out, violations, facts }
}

export function describeBuild(built: Built): string {
  const r = built.report
  const lines = [
    `Built ${r.name} in the ${CHARACTER_STYLES[r.style].name} style: ${r.triangles} triangles, ${r.bones} bones (Godot humanoid names), animations ${r.animations.join(', ')}, ${r.dimensionsM[2]} m tall.`,
    `Textures: ${Object.values(r.textures).join(', ')} (base colour from the references, ORM, normal).`,
    `Files in ${built.dir}: ${[r.files.fbx && `${r.files.fbx} (Unreal)`, r.files.glb && `${r.files.glb} (Godot)`, r.blend].filter(Boolean).join(', ')}.`,
    r.preview ? `Preview beside the references: ${join(built.dir, r.preview)}` : '',
    built.violations.length ? `Contract problems:\n${built.violations.map(v => `- ${v.asset} ${v.rule}: ${v.message}`).join('\n')}` : 'Mesh and textures pass their contracts.',
  ]
  return lines.filter(Boolean).join('\n')
}
