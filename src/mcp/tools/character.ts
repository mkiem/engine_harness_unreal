/**
 * 3D character pipeline MCP tools (reference guide, verification, image generation, Blender build, engine install).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { writeProvenance } from '../../assets/provenance.ts'
import { hasGodotProject, installGodotCharacter } from '../../character/godot.ts'
import { describeConfig, generateImage, PROVIDERS, readImageConfig, saveImageConfig, turnaroundPrompt, type Provider } from '../../character/imagegen.ts'
import { blenderRunner, buildCharacter, CHARACTER_STYLES, characterPaths, describeBuild, type BuildReport, type CharacterStyle } from '../../character/index.ts'
import { checkReferences, describeReport, REFERENCE_GUIDE, VIEWS, type View } from '../../character/reference.ts'
import { sampleSheet } from '../../character/sample.ts'
import { findGodotProject, formatErrors } from '../../godot/bridge.ts'
import { findBlenders } from '../../setup/index.ts'
import { formatResult, NOT_FOUND, runScriptFile } from '../../unreal/bridge.ts'
import { emitProgress, failure, text, type HarnessContext, type ToolExtra } from '../context.ts'

export function registerCharacterTools(ctx: HarnessContext): void {
  const { server, root, unreal, sys, dccDir, godot, godotBinary, within, track } = ctx
  const styleIds = Object.keys(CHARACTER_STYLES) as [CharacterStyle, ...CharacterStyle[]]
  const viewSchema = z.enum(VIEWS)

  track('character', server.registerTool('character_reference_guide', {
    title: 'How to make reference images',
    description: 'What makes reference images a 3D character can be built from: which views (front and side required, back recommended, three-quarter optional), the A-pose, camera, background, lighting, framing and resolution. Show it to the developer before they draw, photograph or generate references.',
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async () => text(REFERENCE_GUIDE)))

  track('character', server.registerTool('character_styles', {
    title: '3D character styles',
    description: 'The 3D styles a character can be built in, from the same references: voxel, lowpoly, toon and retro, with what each looks like and its triangle budget. Each matches a Game Art Style entry (studio_art_style) for the full art direction.',
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async () => text(Object.entries(CHARACTER_STYLES).map(([id, s]) => `- ${id}: ${s.name}. ${s.about} (art style: ${s.artStyle})`).join('\n'))))

  track('character', server.registerTool('character_check_references', {
    title: 'Check reference images',
    description: 'Checks the developer\'s reference images for a 3D character against the guide (views, pose, background, framing, resolution, sharpness, matching scale) and says what to fix in plain words. Give one image per view, or a turnaround sheet with the views side by side. When they pass, the cut-out views are saved for character_build.',
    inputSchema: {
      name: z.string().describe('the character\'s name, such as Hero'),
      front: z.string().optional(), side: z.string().optional(), back: z.string().optional(), three_quarter: z.string().optional(),
      sheet: z.string().optional().describe('a turnaround sheet image with the views left to right'),
      order: z.array(viewSchema).optional().describe('the views in the sheet, left to right (default front, side, back)'),
      sideFacing: z.enum(['right', 'left']).default('right').describe('which way the nose points in the side view'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ name, front, side, back, three_quarter, sheet, order, sideFacing }) => {
    try {
      const files: Partial<Record<View, string>> = {}
      for (const [view, path] of [['front', front], ['side', side], ['back', back], ['three_quarter', three_quarter]] as const) if (path) files[view] = within(path)
      if (!sheet && !Object.keys(files).length) return failure('give the images: front and side (and back), or a turnaround sheet. character_reference_guide says how to make them.')
      const report = checkReferences({ files, sheet: sheet ? within(sheet) : undefined, order, sideFacing }, characterPaths(root, name).reference)
      return { ...text(describeReport(report), { ready: report.ready, dir: report.dir }), ...(report.ready ? {} : { isError: true }) }
    } catch (error) {
      return failure((error as Error).message)
    }
  }))

  track('character', server.registerTool('character_sample_references', {
    title: 'Use the sample references',
    description: 'Saves a sample turnaround sheet (a simple adventurer in an A-pose, front, side and back) as a character\'s references and checks it, so the developer can try the whole 3D character pipeline before they have their own art.',
    inputSchema: { name: z.string().default('Sample') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ name }) => {
    const paths = characterPaths(root, name)
    mkdirSync(paths.reference, { recursive: true })
    const sheet = join(paths.reference, 'sample_sheet.png')
    writeFileSync(sheet, sampleSheet())
    const report = checkReferences({ sheet }, paths.reference)
    return text(`Saved the sample sheet as ${sheet}.\n${describeReport(report)}`, { ready: report.ready })
  }))

  track('character', server.registerTool('character_image_model', {
    title: 'Set up an image model',
    description: 'Shows or sets the image model used to generate reference images: an OpenAI-compatible images API, Google Gemini, local ComfyUI (Flux/SDXL/ControlNet), or local Stable Diffusion (AUTOMATIC1111 / Forge with --api). API keys stay in environment variables (apiKeyEnv names the variable); they are never written to the config. Without a model, the developer uploads their own references.',
    inputSchema: {
      provider: z.enum(PROVIDERS).optional(), baseUrl: z.string().optional(), model: z.string().optional(),
      apiKeyEnv: z.string().optional().describe('the environment variable with the API key, such as OPENAI_API_KEY'), size: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ provider, baseUrl, model, apiKeyEnv, size }) => {
    if (provider) {
      const path = saveImageConfig({ provider: provider as Provider, ...(baseUrl ? { baseUrl } : {}), ...(model ? { model } : {}), ...(apiKeyEnv ? { apiKeyEnv } : {}), ...(size ? { size } : {}) })
      return text(`Saved to ${path}.\n${describeConfig(readImageConfig())}`)
    }
    return text(describeConfig(readImageConfig()))
  }))

  track('character', server.registerTool('character_generate_references', {
    title: 'Generate reference images',
    description: 'Asks the configured image model (character_image_model) for a turnaround sheet that follows the reference guide (front, side, back; A-pose; plain background), optionally steered by the developer\'s own sketch or picture, then checks it like uploaded references. Ask the developer before using a paid API.',
    inputSchema: {
      name: z.string(), description: z.string().describe('who the character is and how they look'),
      style: z.enum(styleIds).default('lowpoly'), fromImage: z.string().optional().describe('a sketch or picture to base the sheet on'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ name, description, style, fromImage }, extra) => {
    const config = readImageConfig()
    if (!config) return failure(`${describeConfig(undefined)}\n\nOr upload references and use character_check_references.`)
    try {
      await emitProgress(extra as ToolExtra, 1, 3, `Generating turnaround sheet with ${config.provider}...`)
      const prompt = turnaroundPrompt(description, style)
      const image = await generateImage(config, prompt, { reference: fromImage ? within(fromImage) : undefined })
      const paths = characterPaths(root, name)
      mkdirSync(paths.reference, { recursive: true })
      const isJpeg = image[0] === 0xff && image[1] === 0xd8
      const sheet = join(paths.reference, `generated_sheet${isJpeg ? '.jpg' : '.png'}`)
      writeFileSync(sheet, image)
      await emitProgress(extra as ToolExtra, 2, 3, 'Checking reference views and silhouettes...')
      const report = checkReferences({ sheet }, paths.reference)
      await emitProgress(extra as ToolExtra, 3, 3, 'Reference check complete.')
      return { ...text(`Generated ${sheet} with ${config.provider}${config.model ? ` (${config.model})` : ''}. Show it to the developer.\n${describeReport(report)}${report.ready ? '' : '\n\nGenerate again (image models vary), or fix the description.'}`, { ready: report.ready, sheet }), ...(report.ready ? {} : { isError: true }) }
    } catch (error) {
      return failure((error as Error).message)
    }
  }))

  track('character', server.registerTool('character_build', {
    title: 'Build the 3D character',
    description: 'Builds a rigged, textured, animated 3D character from the checked references in Blender (no paid service): the shape from the silhouettes, the chosen style (voxel, lowpoly, toon, retro), colours projected from the references and baked into textures (base colour, ORM, normal), a humanoid skeleton with Godot\'s bone names, idle, walk, run and attack animations, then SK_<Name>.fbx for Unreal and <name>.glb for Godot, with a preview beside the references. Checks the mesh and textures against their contracts. Takes about 10 to 60 seconds.',
    inputSchema: {
      name: z.string(), style: z.enum(styleIds).default('lowpoly'), engine: z.enum(['unreal', 'godot', 'both']).default('both'),
      height: z.number().min(0.2).max(20).default(1.8).describe('metres from the soles to the top of the head'),
      triangles: z.number().int().min(100).max(200000).optional().describe('override the style\'s triangle budget'),
      sideFacing: z.enum(['right', 'left']).default('right'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ name, style, engine, height, triangles, sideFacing }, extra) => {
    const blender = findBlenders(sys)[0]?.path
    const runner = blenderRunner(process.env, blender)
    if (!runner) return failure('Blender is needed to build characters (free, blender.org); install Blender 4.2 or later, then try again. harness_setup_check shows what is found.')
    try {
      await emitProgress(extra as ToolExtra, 1, 3, `Building ${name} (${style}) in Blender...`)
      const paths = characterPaths(root, name)
      const built = await buildCharacter(runner, dccDir, { name, style, reference: paths.reference, out: paths.build, engine, height, triangles, sideFacing })
      const primary = built.report.files.glb ?? built.report.files.fbx
      if (primary && existsSync(join(built.dir, primary))) {
        writeProvenance(join(built.dir, primary), {
          assetId: built.report.asset, file: primary, method: 'procedural',
          tool: 'blender (build_character.py)', recipe: 'dcc/blender/character/build_character.py', license: 'proprietary',
        })
      }
      await emitProgress(extra as ToolExtra, 3, 3, 'Build and contract validation complete.')
      return { ...text(`${describeBuild(built)}\n\nShow the developer the preview, then put it in their engine with character_install.`, { ...built.report, dir: built.dir, violations: built.violations }), ...(built.violations.length ? { isError: true } : {}) }
    } catch (error) {
      return failure((error as Error).message)
    }
  }))

  track('character', server.registerTool('character_install', {
    title: 'Put the character in the engine',
    description: 'Godot: copies the character into the Godot project (res://characters/<name>/) with a scene that plays its animations and applies its style (toon cel shading and outline; crisp pixels for voxel and retro), then loads it headless to check bones, animations and textures. Unreal: imports SK_<Name> (with its animations) and the T_<Name> texture set through the project\'s import pipeline in the open editor.',
    inputSchema: { name: z.string(), engine: z.enum(['godot', 'unreal']), project: z.string().optional().describe('the Godot project folder or Unreal project; default the current one') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ name, engine, project }, extra) => {
    const paths = characterPaths(root, name)
    const reportPath = join(paths.build, 'build.json')
    if (!existsSync(reportPath)) return failure('build the character first with character_build')
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as BuildReport
    try {
      if (engine === 'godot') {
        const target = project ? within(project) : findGodotProject(root) ?? root
        if (!hasGodotProject(target)) return failure(`no Godot project at ${target}; give its folder`)
        await emitProgress(extra as ToolExtra, 1, 3, `Installing ${name} into Godot project...`)
        const installed = installGodotCharacter(target, paths.build, report)
        if (!godotBinary()) return text(`Installed ${installed.scene}. Godot is not found, so it was not checked.`)
        await emitProgress(extra as ToolExtra, 2, 3, 'Importing and verifying character in Godot...')
        await godot.importProject(target)
        const run = await godot.exec(target, [installed.scene, '--', '--character-check'], 60_000)
        const line = run.stdout.split(/\r?\n/).find(l => l.startsWith('CHARACTER_CHECK '))
        if (!line) return failure(`Installed ${installed.scene}, but Godot could not load it:\n${formatErrors(run.errors) || run.stdout.slice(-800)}`)
        const check = JSON.parse(line.slice(16))
        await emitProgress(extra as ToolExtra, 3, 3, 'Character verified in Godot.')
        return text(`Installed ${installed.scene}: Godot sees ${check.bones} bones, animations ${check.animations.join(', ')}, ${check.textured ? 'textured' : 'NOT textured'}, ${check.height} m tall, style ${check.style}. Instance the scene in a level; call play("walk") on it to switch animation.`, { scene: installed.scene, check })
      }
      if (!report.files.fbx) return failure('this build has no FBX: build it with engine "unreal" or "both"')
      const jobs = [
        { kind: 'skeletal_mesh', asset: report.asset, file: join(paths.build, report.files.fbx), destination: `/Game/Characters/${report.name}`,
          spec: { id: report.asset, kind: 'skeletal_mesh', requires: { maxTriangles: report.triangles, lods: 1, collision: 'none', animations: true } } },
        { kind: 'texture_set', asset: `T_${report.name}`, file: join(paths.build, report.textures.BC), destination: `/Game/Characters/${report.name}/Textures`,
          spec: { id: `T_${report.name}`, kind: 'texture_set', requires: { maps: ['BaseColor', 'Normal', 'ORM'], normalConvention: 'directx' } } },
      ]
      const lines: string[] = []
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i]!
        await emitProgress(extra as ToolExtra, i + 1, jobs.length, `Importing ${job.asset} into Unreal...`)
        mkdirSync(join(paths.build, 'jobs'), { recursive: true })
        const jobPath = join(paths.build, 'jobs', `${job.asset}.job.json`)
        const resultPath = join(paths.build, 'jobs', `${job.asset}.result.json`)
        writeFileSync(jobPath, JSON.stringify({ ...job, result: resultPath }, null, 2))
        const result = await unreal.run(runScriptFile(resolve(dccDir, 'unreal', 'import_pipeline.py').replace(/\\/g, '/'), ['--job', jobPath.replace(/\\/g, '/')]), { project })
        if (!result.success) return failure(`Unreal could not import ${job.asset}:\n${formatResult(result)}`)
        const outcome = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : {}
        lines.push(`${job.asset}: ${outcome.objectPath ?? 'imported'}${outcome.facts?.animations?.length ? ` with animations ${outcome.facts.animations.join(', ')}` : ''}${outcome.violations?.length ? ` (problems: ${outcome.violations.map((v: { message: string }) => v.message).join('; ')})` : ''}`)
      }
      return text(`Imported into Unreal:\n${lines.join('\n')}\nNext: a material instance of the project's master material with the T_${report.name} textures (for toon, a cel-shading material), and the animations on an Animation Blueprint or played directly.`)
    } catch (error) {
      return failure((error as Error).message || (engine === 'unreal' ? NOT_FOUND : 'the install failed'))
    }
  }))
}

