/**
 * Unreal naming conventions the pipeline enforces. One table, shared by the plan check, the contracts and the prompts, so
 * an LLM planner and a DCC script can never disagree about what SM_ or UCX_ means.
 */
import type { AssetKind } from '../core/model.ts'

/** Required asset-id prefix per kind (Epic's recommended asset naming, as most UE studios use it). */
export const PREFIX: Record<AssetKind, readonly string[]> = {
  static_mesh: ['SM_'],
  skeletal_mesh: ['SK_'],
  texture_set: ['T_'],
  audio_clip: ['SFX_', 'MUS_', 'VO_', 'AMB_'],
  audio_event: ['Play_', 'Stop_'],
  blueprint: ['BP_'],
  level_placement: ['PL_'],
  test_result: ['QA_'],
  sprite_sheet: ['SPR_'],
  tileset: ['TS_'],
  godot_scene: ['SCN_'],
}

export function prefixProblem(kind: AssetKind, id: string): string | undefined {
  const allowed = PREFIX[kind]
  return allowed.some(prefix => id.startsWith(prefix)) ? undefined : `${id} must start with ${allowed.join(' or ')} for a ${kind}`
}

/**
 * Custom collision primitives the FBX importer recognises, all named <TYPE>_<RenderMeshName>_<NN>:
 * UCX convex hull, UBX box, USP sphere, UCP capsule. The render mesh name must match exactly, or the importer silently
 * imports the hull as visible geometry, the most common prop-pipeline bug this contract exists to catch.
 */
export const COLLISION_PREFIXES = ['UCX', 'UBX', 'USP', 'UCP'] as const
const COLLISION = /^(UCX|UBX|USP|UCP)_(.+)_(\d{2})$/

export interface CollisionName { type: typeof COLLISION_PREFIXES[number]; mesh: string; index: number }

export function parseCollisionName(name: string): CollisionName | undefined {
  const match = COLLISION.exec(name)
  if (!match) return undefined
  return { type: match[1] as CollisionName['type'], mesh: match[2]!, index: Number(match[3]) }
}

/** Names that look like collision but would not be recognised, such as `UCX_SM_Radio` (no index) or `ucx_SM_Radio_01`. */
export function looksLikeCollision(name: string): boolean {
  return /^(ucx|ubx|usp|ucp)_/i.test(name)
}

/** Texture map suffixes the master material's parameter names expect. */
export const TEXTURE_SUFFIX: Record<string, string> = { BaseColor: '_BC', Normal: '_N', ORM: '_ORM', Emissive: '_E', Opacity: '_O' }

/** LOD meshes are exported as children named <mesh>_LOD<n> inside an FBX LOD group. */
export const lodName = (mesh: string, lod: number): string => `${mesh}_LOD${lod}`
