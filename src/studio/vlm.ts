/**
 * Optional advisory Vision-Language Model (VLM) visual QA sensor for rendered previews
 * (sprite previews, Blender turntables, 3D character side-by-side renders).
 * Advisory only: catches silhouette, clipping, palette, and readability defects before human review.
 */
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'

export interface VlmConfig {
  provider: 'openai' | 'gemini'
  baseUrl?: string
  model?: string
  apiKeyEnv?: string
}

export interface VisualCritique {
  pass: boolean
  score: number
  summary: string
  issues: string[]
}

const mimeOf = (path: string) => ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[extname(path).toLowerCase()] ?? 'image/png')

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<any> }>

export async function reviewVisualAsset(
  imagePath: string,
  rubric: string,
  config: VlmConfig,
  options: { env?: NodeJS.ProcessEnv; fetch?: Fetch } = {},
): Promise<VisualCritique> {
  const env = options.env ?? process.env
  const http = options.fetch ?? (globalThis.fetch as unknown as Fetch)
  const keyEnv = config.apiKeyEnv ?? (config.provider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY')
  const key = env[keyEnv]
  if (!key) throw new Error(`set ${keyEnv} to run VLM visual review`)

  const b64 = readFileSync(imagePath).toString('base64')
  const mime = mimeOf(imagePath)
  const prompt = `Inspect this game asset preview against the rubric below. Answer with JSON only: {"pass": boolean, "score": 1-10, "summary": string, "issues": string[]}.\n\nRubric:\n${rubric}`

  let rawText = ''
  if (config.provider === 'gemini') {
    const base = (config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '')
    const model = config.model ?? 'gemini-2.5-flash'
    const res = await http(`${base}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: b64 } }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    })
    if (!res.ok) throw new Error(`VLM review failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`)
    const data = await res.json()
    rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  } else {
    const base = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')
    const model = config.model ?? 'gpt-4o-mini'
    const res = await http(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
          ],
        }],
      }),
    })
    if (!res.ok) throw new Error(`VLM review failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`)
    const data = await res.json()
    rawText = data?.choices?.[0]?.message?.content ?? ''
  }

  const parsed = JSON.parse(rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')) as Partial<VisualCritique>
  return {
    pass: Boolean(parsed.pass),
    score: typeof parsed.score === 'number' ? parsed.score : 0,
    summary: String(parsed.summary ?? ''),
    issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
  }
}

