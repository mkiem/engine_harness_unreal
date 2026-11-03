/**
 * Reference images from an image model the developer configures: an OpenAI-compatible images API (OpenAI itself, or
 * any server that speaks its API, local ones included), Google's Gemini image models, or a local Stable Diffusion
 * (the AUTOMATIC1111 / Forge web UI API, free and on your own machine). Engine Harness pays for nothing: the developer
 * brings the key or the local model. The prompt asks for a turnaround sheet that follows the reference guide, so the
 * checker and the 3D build can use it; a developer's own sketch or picture can steer it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { harnessHome } from '../godot/install.ts'

export const PROVIDERS = ['openai', 'gemini', 'a1111'] as const
export type Provider = typeof PROVIDERS[number]

export interface ImageModelConfig {
  provider: Provider
  /** The API's base URL: https://api.openai.com/v1, a compatible server, or http://127.0.0.1:7860 for a1111. */
  baseUrl?: string
  model?: string
  /** The environment variable holding the API key (keys are not stored in the config file). */
  apiKeyEnv?: string
  /** Image size for OpenAI-compatible APIs, such as 1536x1024. */
  size?: string
}

const DEFAULTS: Record<Provider, { baseUrl: string; model: string; apiKeyEnv?: string }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1', apiKeyEnv: 'OPENAI_API_KEY' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash-image', apiKeyEnv: 'GEMINI_API_KEY' },
  a1111: { baseUrl: 'http://127.0.0.1:7860', model: '' },
}

export const configPath = (env: NodeJS.ProcessEnv = process.env) => join(harnessHome(env), 'image-model.json')

/** The configuration: environment variables win over the saved file (HARNESS_IMAGE_PROVIDER, _BASE_URL, _MODEL). */
export function readImageConfig(env: NodeJS.ProcessEnv = process.env): ImageModelConfig | undefined {
  let saved: Partial<ImageModelConfig> = {}
  try {
    if (existsSync(configPath(env))) saved = JSON.parse(readFileSync(configPath(env), 'utf8'))
  } catch { /* an unreadable file counts as none */ }
  const provider = (env.HARNESS_IMAGE_PROVIDER ?? saved.provider) as Provider | undefined
  if (!provider || !PROVIDERS.includes(provider)) return undefined
  return {
    provider,
    baseUrl: env.HARNESS_IMAGE_BASE_URL ?? saved.baseUrl ?? DEFAULTS[provider].baseUrl,
    model: env.HARNESS_IMAGE_MODEL ?? saved.model ?? DEFAULTS[provider].model,
    apiKeyEnv: saved.apiKeyEnv ?? DEFAULTS[provider].apiKeyEnv,
    size: saved.size,
  }
}

export function saveImageConfig(config: ImageModelConfig, env: NodeJS.ProcessEnv = process.env): string {
  const path = configPath(env)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
  return path
}

export function describeConfig(config: ImageModelConfig | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (!config) {
    return [
      'No image model is configured. Developers can upload their own reference images instead, or set one up:',
      '- OpenAI or a compatible API: provider "openai", the key in OPENAI_API_KEY (or another variable via apiKeyEnv); baseUrl for a compatible server.',
      '- Google Gemini: provider "gemini", the key in GEMINI_API_KEY.',
      '- A local Stable Diffusion (free): run the AUTOMATIC1111 or Forge web UI with --api, provider "a1111" (baseUrl http://127.0.0.1:7860 by default).',
    ].join('\n')
  }
  const key = config.apiKeyEnv ? (env[config.apiKeyEnv] ? `key in ${config.apiKeyEnv}` : `no key yet: set ${config.apiKeyEnv}`) : 'no key needed'
  return `Image model: ${config.provider}${config.model ? ` (${config.model})` : ''} at ${config.baseUrl}; ${key}.`
}

/** Words that steer the reference toward each 3D style's look (the shape still comes from the silhouettes). */
export const STYLE_HINTS: Record<string, string> = {
  voxel: 'chunky blocky proportions, simple flat colour areas, like a voxel game character',
  lowpoly: 'simple faceted shapes, a few flat colours per part, like a low-poly game character',
  toon: 'clean cel-shaded anime or cartoon look, bold flat colours, clean outlines',
  retro: 'simple 1990s 3D console game character, bold readable colours, few details',
}

export function turnaroundPrompt(description: string, style: string): string {
  return [
    `Character turnaround reference sheet of ${description}.`,
    'Three full-body views of the same character side by side with clear space between them, left to right: front view, right side profile view facing right, back view.',
    'Orthographic, no perspective, the same scale and height in every view, feet on one baseline.',
    'Neutral A-pose: arms held 30 to 45 degrees away from the body with a gap at the armpits, legs straight and slightly apart, hands open, head straight.',
    'Plain flat white background, even soft lighting, no shadows, no floor, no text, no labels, no props in the hands.',
    `Style: ${STYLE_HINTS[style] ?? style}.`,
  ].join(' ')
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string | FormData }) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<any>; arrayBuffer(): Promise<ArrayBuffer> }>

const mimeOf = (path: string) => ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[extname(path).toLowerCase()] ?? 'image/png')

/** Generates one image (PNG bytes) from a prompt, optionally steered by a reference image. */
export async function generateImage(config: ImageModelConfig, prompt: string, options: { reference?: string; env?: NodeJS.ProcessEnv; fetch?: Fetch } = {}): Promise<Buffer> {
  const env = options.env ?? process.env
  const http = options.fetch ?? (globalThis.fetch as unknown as Fetch)
  const key = config.apiKeyEnv ? env[config.apiKeyEnv] : undefined
  if (config.apiKeyEnv && !key) throw new Error(`set the ${config.apiKeyEnv} environment variable to your ${config.provider} API key first`)
  const base = (config.baseUrl ?? DEFAULTS[config.provider].baseUrl).replace(/\/$/, '')
  const failed = async (response: { status: number; text(): Promise<string> }) => new Error(`${config.provider} answered HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)

  if (config.provider === 'openai') {
    const headers = { Authorization: `Bearer ${key}` }
    let response
    if (options.reference) {
      const form = new FormData()
      form.append('model', config.model ?? DEFAULTS.openai.model)
      form.append('prompt', prompt)
      form.append('size', config.size ?? '1536x1024')
      form.append('image', new Blob([readFileSync(options.reference)], { type: mimeOf(options.reference) }), 'reference' + extname(options.reference))
      response = await http(`${base}/images/edits`, { method: 'POST', headers, body: form })
    } else {
      response = await http(`${base}/images/generations`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.model ?? DEFAULTS.openai.model, prompt, size: config.size ?? '1536x1024', n: 1 }),
      })
    }
    if (!response.ok) throw await failed(response)
    const data = await response.json()
    const item = data?.data?.[0]
    if (item?.b64_json) return Buffer.from(item.b64_json, 'base64')
    if (item?.url) {
      const image = await http(item.url, { method: 'GET', headers: {}, body: '' as any })
      return Buffer.from(await image.arrayBuffer())
    }
    throw new Error('the image API answered without an image')
  }

  if (config.provider === 'gemini') {
    const parts: unknown[] = [{ text: prompt }]
    if (options.reference) parts.push({ inline_data: { mime_type: mimeOf(options.reference), data: readFileSync(options.reference).toString('base64') } })
    const response = await http(`${base}/models/${config.model ?? DEFAULTS.gemini.model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key ?? '' },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ['IMAGE'] } }),
    })
    if (!response.ok) throw await failed(response)
    const data = await response.json()
    for (const part of data?.candidates?.[0]?.content?.parts ?? []) {
      const inline = part.inline_data ?? part.inlineData
      if (inline?.data) return Buffer.from(inline.data, 'base64')
    }
    throw new Error('Gemini answered without an image (the model may not generate images, or the prompt was refused)')
  }

  // a1111: Stable Diffusion WebUI / Forge, started with --api.
  const body: Record<string, unknown> = {
    prompt, negative_prompt: 'perspective, shadows, text, watermark, cropped, extra limbs, props, busy background',
    width: 1536, height: 1024, steps: 28, cfg_scale: 6,
    ...(config.model ? { override_settings: { sd_model_checkpoint: config.model } } : {}),
  }
  if (options.reference) {
    body.init_images = [readFileSync(options.reference).toString('base64')]
    body.denoising_strength = 0.6
  }
  const response = await http(`${base}/sdapi/v1/${options.reference ? 'img2img' : 'txt2img'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!response.ok) throw await failed(response)
  const data = await response.json()
  if (!data?.images?.[0]) throw new Error('the Stable Diffusion API answered without an image')
  return Buffer.from(String(data.images[0]).replace(/^data:image\/\w+;base64,/, ''), 'base64')
}
