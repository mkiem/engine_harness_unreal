/**
 * The harness as an MCP server: composes modular domain tool registrars (pipeline, unreal, godot, assets,
 * character, studio), supports scoped/dynamic toolset activation to prevent context bloat, and exposes
 * MCP tool annotations, progress notifications, and native elicitation.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { AssetLibrary } from '../assets/library.ts'
import { findGodot, findGodotProject, GodotBridge } from '../godot/bridge.ts'
import { FileLockBackend } from '../locks/index.ts'
import { systemEnv } from '../setup/index.ts'
import { defaultCatalogDir } from '../studio/catalog.ts'
import { defaultTemplatesDir } from '../studio/project.ts'
import { UnrealBridge } from '../unreal/bridge.ts'
import {
  ALL_TOOLSETS, createHelpers, defaultDccDir, enginesFromEnv, text, toolsetsFromEnv,
  type HarnessContext, type HarnessServerOptions, type ToolsetId,
} from './context.ts'
import { registerAssetTools } from './tools/assets.ts'
import { registerCharacterTools } from './tools/character.ts'
import { registerGodotTools } from './tools/godot.ts'
import { registerPipelineTools } from './tools/pipeline.ts'
import { registerStudioTools } from './tools/studio.ts'
import { registerUnrealTools } from './tools/unreal.ts'

export { ALL_TOOLSETS, defaultDccDir, enginesFromEnv, toolsetsFromEnv, type HarnessServerOptions, type ToolsetId }

export function createHarnessServer(options: HarnessServerOptions): McpServer {
  const root = resolve(options.projectDir)
  const harnessDir = join(root, '.harness')
  const locks = options.locks ?? new FileLockBackend(join(harnessDir, 'locks.json'))
  const unreal = options.unreal ?? new UnrealBridge()
  const sys = options.setup ?? systemEnv()
  const dccDir = options.dccDir ?? defaultDccDir()
  const engines = options.engines ?? enginesFromEnv()
  const library = options.assets ?? new AssetLibrary()
  const templatesDir = options.templatesDir ?? defaultTemplatesDir(dirname(fileURLToPath(import.meta.url)))
  const catalogDir = options.catalogDir ?? defaultCatalogDir(dirname(fileURLToPath(import.meta.url)))
  let godotPath: string | undefined | null = null
  const godotBinary = () => {
    if (godotPath === null) godotPath = findGodot(sys)[0]?.path
    return godotPath
  }
  const resetGodotBinary = () => { godotPath = null }
  const godot = options.godot ?? new GodotBridge({ godot: godotBinary })
  const godotProject = () => {
    const project = findGodotProject(root)
    if (!project) throw new Error(`no project.godot in ${root} or the folders directly below it`)
    return project
  }

  const configuredToolsets = options.toolsets ?? toolsetsFromEnv()
  const dynamic = options.dynamicToolsets ?? (process.env.HARNESS_DYNAMIC_TOOLSETS === '1' || process.env.HARNESS_DYNAMIC_TOOLSETS === 'true')
  const allowedToolsets = new Set<ToolsetId>(
    configuredToolsets ?? ALL_TOOLSETS.filter(id => (id !== 'unreal' || engines.includes('unreal')) && (id !== 'godot' || engines.includes('godot'))),
  )

  const server = new McpServer({ name: 'engine-harness', version: '0.2.0' }, {
    instructions: [
      'Game-dev pipeline tools. Before making an asset, read harness_conventions for its kind.',
      'Before editing a binary file (.blend, .uasset, .umap, .wav, .wwu), take it with harness_lock, and release it with harness_unlock when done.',
      'Before telling the person an asset is ready, run harness_validate on it and fix every violation.',
      'For a multi-part request (a prop with a mesh, textures, a sound and a Blueprint), plan it with harness_plan_prop, then do the tickets wave by wave; tickets in one wave can run in parallel subagents.',
      'The unreal_* tools drive the open Unreal Editor through Python: inspect and change the level, Blueprints and assets with unreal_python, run checked-in scripts with unreal_run_script, start Play in Editor with unreal_play_in_editor so the developer can playtest, and read unreal_log after changes.',
      'For Godot projects, read and edit .tscn and .gd files directly (they are text); use godot_scene to see a scene, godot_check after editing scripts, and godot_run to catch runtime errors or open the game for the developer to play.',
      'To make a game with someone, especially someone new to it, use the studio: studio_new_project starts one, and every session in a game folder begins with studio_next, which says where the game stands and which skill to load (game-studio explains the whole process).',
      'To make a 3D character from reference images (for Unreal or Godot), load the character-3d skill: character_reference_guide, character_check_references (or character_generate_references with the developer\'s own image model), character_build, character_install.',
      'If Blender or Unreal does not answer, run harness_setup_check, explain what is missing, and with the developer\'s agreement fix it with harness_setup_blender or harness_setup_unreal_project.',
      ...(dynamic ? ['Toolsets load progressively to save context: call harness_toolsets to enable or disable domain toolsets (pipeline, studio, godot, unreal, assets, character).'] : []),
    ].join(' '),
  })

  const byToolset = new Map<ToolsetId, RegisteredTool[]>()
  const track = (toolset: ToolsetId, tool: RegisteredTool) => {
    const list = byToolset.get(toolset) ?? []
    list.push(tool)
    byToolset.set(toolset, list)
    return tool
  }

  const ctx: HarnessContext = {
    server, root, harnessDir, locks, unreal, sys, dccDir, engines, library, templatesDir, catalogDir,
    godot, godotBinary, resetGodotBinary, godotProject, track,
    ...createHelpers(root, harnessDir),
  }

  if (allowedToolsets.has('pipeline')) registerPipelineTools(ctx)
  if (allowedToolsets.has('unreal') && engines.includes('unreal')) registerUnrealTools(ctx)
  if (allowedToolsets.has('godot') && engines.includes('godot')) registerGodotTools(ctx)
  if (allowedToolsets.has('assets')) registerAssetTools(ctx)
  if (allowedToolsets.has('character')) registerCharacterTools(ctx)
  if (allowedToolsets.has('studio')) registerStudioTools(ctx)

  if (dynamic) {
    const active = new Set<ToolsetId>(options.initialToolsets ?? ['pipeline'])
    for (const [id, tools] of byToolset) {
      if (!active.has(id)) for (const tool of tools) tool.disable()
    }
    server.registerTool('harness_toolsets', {
      title: 'Enable or disable toolsets',
      description: 'Progressive tool discovery: lists available domain toolsets and enables/disables them on demand (emitting notifications/tools/list_changed) to keep context lean.',
      inputSchema: {
        enable: z.array(z.enum(ALL_TOOLSETS)).optional().describe('toolsets to enable'),
        disable: z.array(z.enum(ALL_TOOLSETS)).optional().describe('toolsets to disable'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, async ({ enable, disable }) => {
      let changed = false
      for (const id of enable ?? []) {
        if (!byToolset.has(id) || active.has(id)) continue
        for (const tool of byToolset.get(id)!) tool.enable()
        active.add(id)
        changed = true
      }
      for (const id of disable ?? []) {
        if (!byToolset.has(id) || !active.has(id)) continue
        for (const tool of byToolset.get(id)!) tool.disable()
        active.delete(id)
        changed = true
      }
      if (changed) server.sendToolListChanged()
      const summary = [...byToolset.entries()].map(([id, tools]) => `- ${id}: ${active.has(id) ? 'enabled' : 'disabled'} (${tools.length} tools)`)
      return text(`Toolsets:\n${summary.join('\n')}`, { enabled: [...active], available: [...byToolset.keys()] })
    })
  }

  return server
}
