/**
 * Unreal Engine 5 Editor bridge MCP tools.
 * Wraps mutating `unreal_python` calls in `unreal.ScopedEditorTransaction` by default so every AI edit is undoable.
 */
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import { configureUnrealProject, findProjects } from '../../setup/index.ts'
import { formatResult, NOT_FOUND, playInEditorScript, readEditorLog, runScriptFile } from '../../unreal/bridge.ts'
import { failure, text, type HarnessContext } from '../context.ts'

/** Wraps arbitrary Python in an Unreal Editor Undo transaction so changes can be reverted with Ctrl+Z. */
export function wrapScopedTransaction(code: string, description = 'Engine Harness AI Edit'): string {
  const indented = code.split(/\r?\n/).map(line => `    ${line}`).join('\n')
  return `import unreal\nwith unreal.ScopedEditorTransaction(${JSON.stringify(description)}):\n${indented}\n`
}

export function registerUnrealTools(ctx: HarnessContext): void {
  const { server, root, unreal, sys, dccDir, within, track } = ctx
  const editorError = (error: unknown) => failure((error as Error).message || NOT_FOUND)

  track('unreal', server.registerTool('unreal_status', {
    title: 'Unreal Editor status',
    description: 'Which Unreal Editors are open on this machine and answering (project, engine version), and which one commands go to.',
    inputSchema: { project: z.string().optional().describe('project name or folder, when several editors are open') },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async ({ project }) => {
    try {
      const editors = await unreal.editors()
      if (!editors.length) return failure(NOT_FOUND)
      const target = await unreal.connect(project).catch(error => error as Error)
      const lines = editors.map(editor => `- ${editor.projectName} (UE ${editor.engineVersion}) at ${editor.projectRoot}`)
      return text([`Open editors:`, ...lines, target instanceof Error ? target.message : `Commands go to ${target.projectName}.`].join('\n'), { editors })
    } catch (error) {
      return editorError(error)
    }
  }))

  track('unreal', server.registerTool('unreal_python', {
    title: 'Run Python in the Unreal Editor',
    description: 'Runs Python in the open Unreal Editor (the `unreal` module) and returns what it printed. Use it to inspect and change levels, actors, assets and Blueprints. Prefer EditorActorSubsystem, EditorAssetLibrary, AssetToolsHelpers and the other editor subsystems; save what you change. Set `transaction: true` to wrap edits in an Undo transaction.',
    inputSchema: {
      code: z.string(),
      mode: z.enum(['ExecuteFile', 'ExecuteStatement', 'EvaluateStatement']).optional().describe('ExecuteFile (default) runs a script; EvaluateStatement returns one expression\'s value'),
      project: z.string().optional(),
      transaction: z.boolean().optional().describe('wrap ExecuteFile code in unreal.ScopedEditorTransaction for single-step Undo'),
      transactionName: z.string().optional().describe('Undo label shown in Unreal Editor'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ code, mode, project, transaction, transactionName }) => {
    try {
      const shouldWrap = transaction === true && (!mode || mode === 'ExecuteFile')
      const payload = shouldWrap ? wrapScopedTransaction(code, transactionName) : code
      const result = await unreal.run(payload, { mode, project })
      return result.success ? text(formatResult(result), { success: true }) : { ...text(formatResult(result), { success: false }), isError: true }
    } catch (error) {
      return editorError(error)
    }
  }))

  track('unreal', server.registerTool('unreal_run_script', {
    title: 'Run a script file in the Unreal Editor',
    description: 'Runs a Python script file inside the open Unreal Editor with sys.argv set, such as dcc/unreal/import_pipeline.py --job <job.json> or dcc/unreal/inspect_asset.py blueprint /Game/Props/X/BP_X (see harness_scripts).',
    inputSchema: { path: z.string(), args: z.array(z.string()).default([]), project: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ path, args, project }) => {
    const full = isAbsolute(path) ? path : existsSync(resolve(dccDir, path)) ? resolve(dccDir, path) : existsSync(resolve(dccDir, '..', path)) ? resolve(dccDir, '..', path) : within(path)
    if (!existsSync(full)) return failure(`no script at ${full}`)
    try {
      const result = await unreal.run(runScriptFile(full.replace(/\\/g, '/'), args), { project })
      return result.success ? text(formatResult(result), { success: true }) : { ...text(formatResult(result), { success: false }), isError: true }
    } catch (error) {
      return editorError(error)
    }
  }))

  track('unreal', server.registerTool('unreal_play_in_editor', {
    title: 'Play in Editor',
    description: 'Starts or stops Play in Editor, or reports whether it is running. Start it when a change is ready for the developer to playtest; stop it before changing assets or Blueprints.',
    inputSchema: { action: z.enum(['start', 'stop', 'status']), project: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ action, project }) => {
    try {
      const result = await unreal.run(playInEditorScript(action), { project })
      return result.success ? text(formatResult(result)) : failure(formatResult(result))
    } catch (error) {
      return editorError(error)
    }
  }))

  track('unreal', server.registerTool('unreal_log', {
    title: 'Read the Unreal Editor log',
    description: 'The last lines of the open project\'s editor log, where Blueprint compile errors, import warnings and Play in Editor output appear. `filter` is a case-insensitive regular expression, such as "error|warning".',
    inputSchema: { lines: z.number().int().min(1).max(1000).default(80), filter: z.string().optional(), project: z.string().optional() },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async ({ lines, filter, project }) => {
    try {
      const editor = await unreal.connect(project)
      return text(readEditorLog(editor.projectRoot, editor.projectName, { lines, filter }))
    } catch (error) {
      return editorError(error)
    }
  }))

  track('unreal', server.registerTool('harness_setup_unreal_project', {
    title: 'Set up an Unreal project for the editor bridge',
    description: 'Enables the Python Editor Script Plugin and Editor Scripting Utilities in the .uproject and turns on Python remote execution, keeping .bak copies. Changes project files: ask the developer first, and tell them to restart the editor.',
    inputSchema: { uproject: z.string().optional().describe('path to the .uproject; defaults to the one in the project folder') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ uproject }) => {
    const target = uproject ? within(uproject) : findProjects(sys, root)[0]
    if (!target) return failure(`no .uproject found under ${root}; pass its path`)
    try {
      return text(configureUnrealProject(sys, target).map(step => `- ${step}`).join('\n'))
    } catch (error) {
      return failure((error as Error).message)
    }
  }))
}

