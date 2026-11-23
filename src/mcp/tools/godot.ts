/**
 * Godot 4 engine bridge MCP tools.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { configurePixelArt, findGodot, findGodotProject, formatErrors, listScripts, readProjectName, resToPath } from '../../godot/bridge.ts'
import { findNode, parseTscn, sceneTree } from '../../godot/tscn.ts'
import { failure, text, type HarnessContext } from '../context.ts'

export function registerGodotTools(ctx: HarnessContext): void {
  const { server, root, sys, godot, godotProject, track } = ctx
  const godotFailure = (error: unknown) => failure((error as Error).message)

  track('godot', server.registerTool('godot_status', {
    title: 'Godot status',
    description: 'The Godot 4 executable found and the open Godot project.',
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async () => {
    const installs = findGodot(sys)
    const project = findGodotProject(root)
    return text([
      installs.length ? `Godot ${installs[0]!.version} at ${installs[0]!.path}` : 'Godot 4 not found (install it, or set GODOT_BIN)',
      project ? `Project "${readProjectName(project)}" at ${project}` : `No project.godot in ${root}`,
    ].join('\n'), { godot: installs[0] ?? null, project: project ?? null })
  }))

  track('godot', server.registerTool('godot_scene', {
    title: 'Read a Godot scene',
    description: 'A .tscn scene as a compact node tree, or one node\'s properties when `node` is given (a path like "." or "Sprite" or "UI/Health").',
    inputSchema: { path: z.string().describe('res:// or project-relative .tscn path'), node: z.string().optional() },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async ({ path, node }) => {
    try {
      const project = godotProject()
      const file = path.startsWith('res://') ? resToPath(project, path) : resolve(project, path)
      if (!existsSync(file)) return failure(`no scene at ${file}`)
      const scene = parseTscn(readFileSync(file, 'utf8'))
      if (!node) return text(sceneTree(scene))
      const found = findNode(scene, node)
      if (!found) return failure(`no node ${node}; nodes: ${scene.nodes.map(item => item.parent === undefined ? '.' : item.parent === '.' ? item.name : `${item.parent}/${item.name}`).join(', ')}`)
      const props = Object.entries(found.properties).map(([key, value]) => `${key} = ${value}`)
      return text([`${found.name} (${found.type ?? 'instance'})`, ...props].join('\n'))
    } catch (error) {
      return godotFailure(error)
    }
  }))

  track('godot', server.registerTool('godot_check', {
    title: 'Validate GDScript',
    description: 'Parses GDScript with Godot (--check-only): the given files, or every script in the project outside addons/.',
    inputSchema: { files: z.array(z.string()).optional().describe('res:// or project-relative .gd paths') },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async ({ files }) => {
    try {
      const project = godotProject()
      const targets = files?.length ? files.map(file => file.startsWith('res://') ? file : resolve(project, file)) : listScripts(project)
      if (!targets.length) return text('No GDScript files to check.')
      const { checked, errors } = await godot.check(project, targets)
      return errors.length ? { ...text(`${errors.length} error(s) in ${checked} script(s):\n${formatErrors(errors)}`, { errors }), isError: true } : text(`✓ ${checked} script(s) parse cleanly.`, { errors: [] })
    } catch (error) {
      return godotFailure(error)
    }
  }))

  track('godot', server.registerTool('godot_run', {
    title: 'Run the Godot game',
    description: 'Runs the project (or one scene) headless for `seconds` and reports errors; with window: true, opens it for the developer to play instead.',
    inputSchema: { scene: z.string().optional(), seconds: z.number().min(1).max(60).default(5), window: z.boolean().default(false) },
    annotations: { readOnlyHint: true, idempotentHint: false },
  }, async ({ scene, seconds, window }) => {
    try {
      const project = godotProject()
      if (window) {
        const pid = godot.play(project, scene)
        return text(`Opened the game in a window${pid ? ` (pid ${pid})` : ''}. Ask the developer what they see.`)
      }
      const result = await godot.runHeadless(project, { scene, frames: Math.round(seconds * 60) })
      if (result.errors.length) return { ...text(`${result.errors.length} error(s) while running:\n${formatErrors(result.errors)}`, { errors: result.errors }), isError: true }
      return text(`Ran ${seconds} s with no errors${result.timedOut ? ' (stopped at the time limit)' : ''}.\n${result.output.split('\n').slice(-10).join('\n')}`, { errors: [] })
    } catch (error) {
      return godotFailure(error)
    }
  }))

  track('godot', server.registerTool('harness_setup_godot_project', {
    title: 'Pixel-art defaults for a Godot project',
    description: 'Sets crisp pixel-art defaults in project.godot (nearest filtering, pixel snapping, base resolution scaled by whole numbers), keeping a backup. Ask the developer first.',
    inputSchema: { width: z.number().int().default(320), height: z.number().int().default(180), windowScale: z.number().int().min(1).max(8).default(4) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ width, height, windowScale }) => {
    try {
      return text(configurePixelArt(sys, godotProject(), { width, height, windowScale }).join('\n'))
    } catch (error) {
      return godotFailure(error)
    }
  }))
}

