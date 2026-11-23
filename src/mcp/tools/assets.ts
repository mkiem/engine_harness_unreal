/**
 * Starter asset library MCP tools (Poly Haven, ambientCG, Kenney, Godot Asset Library, local imports).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { importLocal, installGodotAddon, libraryDirFor, SOURCES, type SourceId } from '../../assets/library.ts'
import { writeProvenance } from '../../assets/provenance.ts'
import { findGodotProject } from '../../godot/bridge.ts'
import { findProjects } from '../../setup/index.ts'
import { failure, text, type HarnessContext } from '../context.ts'

export function registerAssetTools(ctx: HarnessContext): void {
  const { server, root, sys, library, within, track } = ctx
  const sourceIds = SOURCES.map(source => source.id) as [SourceId, ...SourceId[]]

  track('assets', server.registerTool('assets_sources', {
    title: 'Asset sources',
    description: 'Where to get ready-made game assets: openly licensed libraries the harness downloads from, and marketplaces the developer uses with their own account. Each with its licence and how to get assets.',
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async () => text(SOURCES.map(source => `## ${source.name} (${source.id}): ${source.access === 'download' ? 'downloadable here' : 'guide only'}\n${source.license}. ${source.kinds.join(', ')}.\n${source.howTo}${source.credit ? `\n${source.credit}` : ''}`).join('\n\n'))))

  track('assets', server.registerTool('assets_search', {
    title: 'Search an asset library',
    description: 'Searches an openly licensed library: polyhaven (HDRIs, textures, models), ambientcg (PBR materials), kenney (curated CC0 game kits: pixel-art tiles, UI, sounds; downloaded from their page, then assets_import), godot-assetlib (Godot add-ons).',
    inputSchema: { source: z.enum(sourceIds), query: z.string(), kind: z.string().optional().describe('polyhaven: hdri, texture or model') },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ source, query, kind }) => {
    try {
      const results = await library.search(source, query, { kind })
      if (!results.length) return text(`No ${source} results for "${query}".`)
      return text(results.map(result => `- ${result.id}: ${result.title} [${result.license}${result.author ? `, ${result.author}` : ''}]${result.kind ? ` (${result.kind})` : ''}`).join('\n'), { results })
    } catch (error) {
      return failure((error as Error).message)
    }
  }))

  track('assets', server.registerTool('assets_download', {
    title: 'Download an asset into the project',
    description: 'Downloads one asset into the project\'s library folder (library/ in Godot, ArtSource/Library/ in Unreal) with asset.json and LICENSE.txt beside it; Godot add-ons are also installed into addons/. Record the source and licence in the asset\'s provenance (method: library).',
    inputSchema: {
      source: z.enum(sourceIds), id: z.string(),
      resolution: z.string().optional().describe('polyhaven: 1k, 2k, 4k; ambientcg: 1K, 2K'),
      format: z.string().optional().describe('polyhaven: png, jpg, hdr, exr; ambientcg: PNG or JPG'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ source, id, resolution, format }) => {
    try {
      const godotRoot = findGodotProject(root)
      const kind = godotRoot ? 'godot' : findProjects(sys, root).length ? 'unreal' : 'other'
      const done = await library.download(source, id, libraryDirFor(godotRoot ?? root, kind), { resolution, format })
      if (done.files[0] && existsSync(join(done.dir, done.files[0]))) {
        writeProvenance(join(done.dir, done.files[0]), {
          assetId: `${source}:${id}`, file: done.files[0], method: 'library', tool: source,
          ...(done.author ? { author: done.author } : {}), license: done.license,
        })
      }
      const installed = source === 'godot-assetlib' && godotRoot ? installGodotAddon(done.dir, godotRoot) : []
      const shown = done.files.slice(0, 15).map(file => `  ${file}`)
      return text([`Downloaded ${source} ${id} to ${done.dir} (${done.files.length} file(s)), licence ${done.license}${done.author ? `, by ${done.author}` : ''}.`, ...shown, ...(done.files.length > 15 ? [`  … ${done.files.length - 15} more`] : []),
        ...(installed.length ? [`Installed ${installed.join(', ')}; enable it in Project Settings → Plugins if it is an editor plugin.`] : [])].join('\n'), { ...done, installed })
    } catch (error) {
      return failure((error as Error).message)
    }
  }))

  track('assets', server.registerTool('assets_import', {
    title: 'Import a downloaded asset',
    description: 'Brings a file the developer downloaded (a Kenney kit zip, a Freesound sound, an OpenGameArt pack) into the project\'s library, unpacked, with its source and licence recorded.',
    inputSchema: {
      file: z.string(), source: z.enum([...sourceIds, 'other'] as [string, ...string[]]), id: z.string(),
      license: z.string().default('CC0'), author: z.string().optional(), url: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ file, source, id, license, author, url }) => {
    const path = within(file)
    if (!existsSync(path)) return failure(`no file at ${path}`)
    try {
      const godotRoot = findGodotProject(root)
      const kind = godotRoot ? 'godot' : findProjects(sys, root).length ? 'unreal' : 'other'
      const done = importLocal(path, libraryDirFor(godotRoot ?? root, kind), { source: source as SourceId | 'other', id, license, author, url })
      return text(`Imported ${id} into ${done.dir} (${done.files.length} file(s)), licence ${license}.`, { ...done })
    } catch (error) {
      return failure((error as Error).message)
    }
  }))
}

