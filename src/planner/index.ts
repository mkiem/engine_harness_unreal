/**
 * Planners turn a brief into a Plan. The Router layer only routes and plans; it never models, textures or writes
 * Blueprints itself, and it runs without a shell (the super-agent design's Router constraint).
 *
 * - PropPlanner: a deterministic template for the most common unit of work, an interactive prop. No model needed.
 * - LlmPlanner: a model writes the plan from free text; `parsePlan` checks it, and the problems go back to the model
 *   for a bounded number of repairs, so a structural mistake never reaches a worker.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { PREFIX } from '../contracts/naming.ts'
import type { Plan, TicketSpec } from '../core/model.ts'
import { parsePlan, PlanError } from '../core/plan.ts'

export interface Planner {
  plan(brief: string): Promise<Plan>
}

// ---- deterministic prop template ---------------------------------------------------------------------------------------

export const PropBrief = z.object({
  /** PascalCase base name; becomes SM_<name>, T_<name>, BP_<name>. */
  name: z.string().regex(/^[A-Z][A-Za-z0-9]{1,40}$/),
  description: z.string(),
  sizeCm: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]),
  maxTriangles: z.number().int().positive().default(8000),
  lods: z.number().int().min(1).default(3),
  textureResolution: z.number().int().default(2048),
  sound: z.object({
    name: z.string().regex(/^[A-Z][A-Za-z0-9]{1,40}$/),
    description: z.string(),
    loop: z.boolean().default(true),
    maxDistanceCm: z.number().positive().default(1500),
  }).strict().optional(),
  /** What the player does with it; becomes the Blueprint's instructions. */
  interaction: z.string().optional(),
  placement: z.object({ map: z.string(), location: z.tuple([z.number(), z.number(), z.number()]) }).strict().optional(),
  /** Holds the mesh and textures for art-direction sign-off before the engine work starts. */
  artReview: z.boolean().default(false),
  contentRoot: z.string().optional(),
}).strict()
export type PropBrief = z.infer<typeof PropBrief>

const kebab = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()

export function propPlan(input: PropBrief): Plan {
  const brief = PropBrief.parse(input)
  const id = kebab(brief.name)
  const mesh = `SM_${brief.name}`
  const texture = `T_${brief.name}`
  const blueprint = `BP_${brief.name}`
  const material = `MI_${brief.name}`
  const contentRoot = brief.contentRoot ?? `/Game/Props/${brief.name}`
  const tickets: TicketSpec[] = []
  const review = brief.artReview ? 'human' as const : 'auto' as const

  tickets.push({
    id: `${id}-model`, domain: 'blender', title: `Model ${mesh}`, review, maxRevisions: 2, after: [], consumes: [],
    instructions: `Model ${brief.description}. Real-world size about ${brief.sizeCm.join(' x ')} cm. Build it with a bpy recipe script, unwrap UVs, author convex collision hulls, generate ${brief.lods} LODs, and export FBX.`,
    produces: [{ id: mesh, kind: 'static_mesh', description: brief.description, requires: {
      maxTriangles: brief.maxTriangles, lods: brief.lods, collision: 'ucx', pivot: 'base', approxSizeCm: brief.sizeCm, sizeTolerance: 0.5,
      materialSlots: [material], lightmapUv: true } }],
    locks: [`ArtSource/Props/${brief.name}/${mesh}.blend`],
  })
  tickets.push({
    id: `${id}-texture`, domain: 'texture', title: `Texture ${texture}`, review, maxRevisions: 2, after: [], consumes: [mesh],
    instructions: `Author PBR textures for ${brief.description} on the UVs of ${mesh}: bake normal and ambient occlusion from the mesh, then paint base colour, roughness and metallic, channel-packed as ORM.`,
    produces: [{ id: texture, kind: 'texture_set', description: `PBR set for ${mesh}`, requires: { resolution: brief.textureResolution, maps: ['BaseColor', 'Normal', 'ORM'], normalConvention: 'directx' } }],
    locks: [`ArtSource/Props/${brief.name}/${texture}.spp`],
  })
  const audioIds: string[] = []
  if (brief.sound) {
    const clip = `SFX_${brief.sound.name}`
    const event = `Play_${brief.sound.name}`
    audioIds.push(event)
    tickets.push({
      id: `${id}-audio`, domain: 'audio', title: `Sound ${clip} and ${event}`, review: 'auto', maxRevisions: 2, after: [], consumes: [],
      instructions: `Make ${brief.sound.description}${brief.sound.loop ? ' as a seamless loop' : ''} with a reproducible synthesis script, import it into Wwise, create the event ${event} with 3D attenuation, and generate SoundBanks.`,
      produces: [
        { id: clip, kind: 'audio_clip', description: brief.sound.description, requires: { sampleRate: 48000, channels: 1, bitDepth: 16, minSeconds: 1, maxSeconds: 20, maxPeakDb: -1, loudnessDb: [-30, -12], loop: brief.sound.loop } },
        { id: event, kind: 'audio_event', description: `Plays ${clip}`, requires: { clip, attenuation: `ATT_${brief.sound.name}`, maxDistanceCm: brief.sound.maxDistanceCm, bus: 'Master Audio Bus' } },
      ],
      locks: [`Wwise/Events/${event}.wwu`],
    })
  }
  const components = ['StaticMeshComponent', ...(brief.sound ? ['AkComponent'] : [])]
  const blueprintProduces: TicketSpec['produces'] = [{ id: blueprint, kind: 'blueprint', description: brief.interaction ?? brief.description, requires: {
    parentClass: 'Actor', components, interfaces: brief.interaction ? ['BPI_Interactable'] : [] } }]
  if (brief.placement) blueprintProduces.push({ id: `PL_${brief.name}`, kind: 'level_placement', description: `${blueprint} placed in ${brief.placement.map}`, requires: {
    map: brief.placement.map, actorClass: blueprint, location: brief.placement.location, rotation: [0, 0, 0], oneFilePerActor: true } })
  tickets.push({
    id: `${id}-blueprint`, domain: 'unreal', title: `Blueprint ${blueprint}`, review: 'auto', maxRevisions: 2, after: [],
    consumes: [mesh, texture, ...audioIds],
    instructions: [
      `Create ${material} from the project's master prop material with ${texture}'s maps, assign it to ${mesh}, and create ${blueprint} (Actor) with a StaticMeshComponent showing ${mesh}${brief.sound ? ` and an AkComponent for ${audioIds[0]}` : ''}.`,
      brief.interaction ? `Implement BPI_Interactable: ${brief.interaction}.` : '',
      brief.placement ? `Place one ${blueprint} in ${brief.placement.map} at ${brief.placement.location.join(', ')}.` : '',
    ].filter(Boolean).join(' '),
    produces: blueprintProduces,
    locks: [`Content/Props/${brief.name}/${blueprint}.uasset`, `Content/Props/${brief.name}/${material}.uasset`],
  })
  tickets.push({
    id: `${id}-qa`, domain: 'qa', title: `Verify ${blueprint}`, review: 'auto', maxRevisions: 1, after: [], consumes: brief.placement ? [`PL_${brief.name}`] : [blueprint],
    instructions: `Write and run automation tests that spawn ${blueprint}, check its collision blocks a player capsule${brief.interaction ? ', trigger the interaction and check the expected effect' : ''}${brief.sound ? `, and check that ${audioIds[0]} posts` : ''}.`,
    produces: [{ id: `QA_${brief.name}`, kind: 'test_result', description: `Automation results for ${blueprint}`, requires: {
      tests: [`Project.Props.${brief.name}.Collision`, ...(brief.interaction ? [`Project.Props.${brief.name}.Interact`] : [])] } }],
    locks: [],
  })
  return parsePlan({ id, brief: brief.description, contentRoot, tickets })
}

// ---- LLM planner -------------------------------------------------------------------------------------------------------

export interface ChatModel {
  complete(messages: { role: 'system' | 'user' | 'assistant'; content: string }[]): Promise<string>
}

/** OpenAI-compatible chat completions: DeepSeek by default, or any compatible endpoint (vLLM, Ollama, OpenRouter). */
export class OpenAICompatibleModel implements ChatModel {
  private readonly options: { baseUrl: string; model: string; apiKey?: string; fetch?: typeof fetch }
  constructor(options: { baseUrl?: string; model?: string; apiKey?: string; fetch?: typeof fetch } = {}) {
    this.options = { baseUrl: options.baseUrl ?? 'https://api.deepseek.com', model: options.model ?? 'deepseek-chat', apiKey: options.apiKey, fetch: options.fetch }
  }
  async complete(messages: { role: 'system' | 'user' | 'assistant'; content: string }[]): Promise<string> {
    const response = await (this.options.fetch ?? fetch)(`${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.options.model, messages, temperature: 0.2, response_format: { type: 'json_object' } }),
    })
    if (!response.ok) throw new Error(`planner model answered ${response.status}: ${(await response.text()).slice(0, 300)}`)
    const body = await response.json() as { choices?: { message?: { content?: string } }[] }
    const content = body.choices?.[0]?.message?.content
    if (!content) throw new Error('planner model returned no content')
    return content
  }
}

export class LlmPlanner implements Planner {
  private readonly model: ChatModel
  private readonly repoRoot: string
  private readonly maxRepairs: number
  constructor(options: { model: ChatModel; repoRoot: string; maxRepairs?: number }) {
    this.model = options.model
    this.repoRoot = options.repoRoot
    this.maxRepairs = options.maxRepairs ?? 2
  }

  async plan(brief: string): Promise<Plan> {
    const naming = Object.entries(PREFIX).map(([kind, prefixes]) => `- ${kind}: ${prefixes.join(', ')}`).join('\n')
    const system = readFileSync(join(this.repoRoot, 'prompts/router.md'), 'utf8').replace('{{naming}}', naming)
      .replace('{{example}}', readFileSync(join(this.repoRoot, 'examples/vintage-radio/plan.json'), 'utf8'))
    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [{ role: 'system', content: system }, { role: 'user', content: brief }]
    for (let attempt = 0; ; attempt++) {
      const answer = await this.model.complete(messages)
      try {
        return parsePlan(JSON.parse(stripFence(answer)))
      } catch (error) {
        const problems = error instanceof PlanError ? error.problems : [`not valid JSON: ${(error as Error).message}`]
        if (attempt >= this.maxRepairs) throw error instanceof PlanError ? error : new PlanError(problems)
        messages.push({ role: 'assistant', content: answer }, { role: 'user', content: `The plan was rejected. Fix every problem and answer with the whole corrected plan as JSON:\n- ${problems.join('\n- ')}` })
      }
    }
  }
}

const stripFence = (text: string) => text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
