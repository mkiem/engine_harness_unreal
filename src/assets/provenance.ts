/**
 * Standardized asset provenance manifest sidecars (`<asset>.provenance.json`).
 * Records reproducible origin metadata (method, tool/model, prompt hash, SHA-256, license, timestamp)
 * across procedural, generative, handmade, and downloaded library assets.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'

export const ProvenanceManifest = z.object({
  schemaVersion: z.literal('1.0').default('1.0'),
  assetId: z.string().min(1),
  file: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  method: z.enum(['handmade', 'procedural', 'generative', 'library', 'recorded']),
  tool: z.string().min(1),
  model: z.string().optional(),
  promptHash: z.string().optional(),
  recipe: z.string().optional(),
  sourceUrl: z.string().optional(),
  author: z.string().optional(),
  license: z.string().min(1),
  createdAt: z.string(),
}).strict()
export type ProvenanceManifest = z.infer<typeof ProvenanceManifest>

export const sha256Of = (content: Buffer | string) => createHash('sha256').update(content).digest('hex')

export function provenanceSidecarPath(assetPath: string): string {
  return `${assetPath}.provenance.json`
}

export function writeProvenance(assetPath: string, input: Omit<ProvenanceManifest, 'schemaVersion' | 'sha256' | 'createdAt' | 'promptHash'> & { prompt?: string; content?: Buffer | string }): { path: string; manifest: ProvenanceManifest } {
  const bytes = input.content ?? readFileSync(assetPath)
  const manifest = ProvenanceManifest.parse({
    schemaVersion: '1.0',
    assetId: input.assetId,
    file: input.file,
    sha256: sha256Of(bytes),
    method: input.method,
    tool: input.tool,
    ...(input.model ? { model: input.model } : {}),
    ...(input.prompt ? { promptHash: sha256Of(input.prompt) } : {}),
    ...(input.recipe ? { recipe: input.recipe } : {}),
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    ...(input.author ? { author: input.author } : {}),
    license: input.license,
    createdAt: new Date().toISOString(),
  })
  const sidecar = provenanceSidecarPath(assetPath)
  mkdirSync(dirname(sidecar), { recursive: true })
  writeFileSync(sidecar, `${JSON.stringify(manifest, null, 2)}\n`)
  return { path: sidecar, manifest }
}

export function readProvenance(assetPath: string): ProvenanceManifest | undefined {
  const sidecar = provenanceSidecarPath(assetPath)
  if (!existsSync(sidecar)) return undefined
  return ProvenanceManifest.parse(JSON.parse(readFileSync(sidecar, 'utf8')))
}

