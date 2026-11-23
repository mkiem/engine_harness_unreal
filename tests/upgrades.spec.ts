import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { readProvenance, writeProvenance } from '../src/assets/provenance.ts'
import { generateImage } from '../src/character/imagegen.ts'
import { checkAsset } from '../src/contracts/index.ts'
import { readWav, writeWav16 } from '../src/contracts/wav.ts'
import { AssetSpec } from '../src/core/model.ts'
import { Orchestrator } from '../src/core/orchestrator.ts'
import { parsePlan } from '../src/core/plan.ts'
import { Pools } from '../src/core/pools.ts'
import { SqliteRunStore } from '../src/core/store.ts'
import { BudgetTracker, TraceCollector } from '../src/core/telemetry.ts'
import { checkCommandPolicy, isWithinAllowedRoots, writeSandboxHooks } from '../src/executors/sandbox.ts'
import { radioStatic, SimulatedExecutor } from '../src/executors/simulated.ts'
import { SimulatedIngestor } from '../src/ingest/index.ts'
import { LockManager, MemoryLockBackend, SqliteLockBackend } from '../src/locks/index.ts'
import { createHarnessServer } from '../src/mcp/server.ts'
import { wrapScopedTransaction } from '../src/mcp/tools/unreal.ts'
import { createProject, defaultTemplatesDir } from '../src/studio/project.ts'
import { reviewVisualAsset } from '../src/studio/vlm.ts'
import { tempDir } from './fixtures.ts'

describe('P0: MCP toolsets, dynamic loading, annotations, and UE Undo', () => {
  it('restricts exposed tools via scoped toolsets', async () => {
    const server = createHarnessServer({ projectDir: tempDir(), toolsets: ['pipeline', 'godot'] })
    const client = new Client({ name: 'test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    const names = (await client.listTools()).tools.map(t => t.name)
    expect(names).toContain('harness_validate')
    expect(names).toContain('godot_scene')
    expect(names.some(n => n.startsWith('studio_'))).toBe(false)
    expect(names.some(n => n.startsWith('unreal_'))).toBe(false)
    await client.close()
  })

  it('supports progressive dynamic toolset activation via harness_toolsets', async () => {
    const server = createHarnessServer({ projectDir: tempDir(), dynamicToolsets: true, initialToolsets: ['pipeline'] })
    const client = new Client({ name: 'test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])

    const before = (await client.listTools()).tools.map(t => t.name)
    expect(before).toContain('harness_toolsets')
    expect(before).toContain('harness_validate')
    expect(before).not.toContain('studio_next')

    await client.callTool({ name: 'harness_toolsets', arguments: { enable: ['studio'] } })
    const after = (await client.listTools()).tools.map(t => t.name)
    expect(after).toContain('studio_next')

    await client.callTool({ name: 'harness_toolsets', arguments: { disable: ['studio'] } })
    const disabled = (await client.listTools()).tools.map(t => t.name)
    expect(disabled).not.toContain('studio_next')
    await client.close()
  })

  it('publishes MCP tool annotations on read-only and destructive tools', async () => {
    const server = createHarnessServer({ projectDir: tempDir() })
    const client = new Client({ name: 'test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    const tools = new Map((await client.listTools()).tools.map(t => [t.name, t]))
    expect(tools.get('studio_next')?.annotations?.readOnlyHint).toBe(true)
    expect(tools.get('unreal_python')?.annotations?.destructiveHint).toBe(true)
    expect(tools.get('studio_export')?.annotations?.openWorldHint).toBe(true)
    await client.close()
  })

  it('wraps Unreal Python code in ScopedEditorTransaction', () => {
    const wrapped = wrapScopedTransaction('print("hi")\nx = 1', 'Test Undo')
    expect(wrapped).toContain('with unreal.ScopedEditorTransaction("Test Undo"):')
    expect(wrapped).toContain('    print("hi")')
    expect(wrapped).toContain('    x = 1')
  })
})

describe('P0: Sandbox policy enforcement and SQLite locks', () => {
  it('blocks disallowed commands including chained invocations', () => {
    expect(checkCommandPolicy('git status', ['p4 submit', 'git push']).allowed).toBe(true)
    expect(checkCommandPolicy('git add . && git push origin main', ['p4 submit', 'git push']).allowed).toBe(false)
    expect(checkCommandPolicy('p4 submit -d "ship"', ['p4 submit']).allowed).toBe(false)
  })

  it('enforces workspace boundaries and writes PreToolUse hooks', () => {
    const dir = tempDir()
    expect(isWithinAllowedRoots(join(dir, 'sub', 'a.txt'), [dir])).toBe(true)
    expect(isWithinAllowedRoots(join(dir, '..', 'outside.txt'), [dir])).toBe(false)
    const hooks = writeSandboxHooks(dir, ['p4 submit'])
    expect(existsSync(hooks.policyFile)).toBe(true)
    expect(existsSync(hooks.hookScript)).toBe(true)
    expect(existsSync(hooks.claudeSettings)).toBe(true)
    expect(readFileSync(hooks.claudeSettings, 'utf8')).toContain('PreToolUse')
  })

  it('coordinates locks across processes via SqliteLockBackend', () => {
    const dbFile = join(tempDir(), 'locks.db')
    const a = new SqliteLockBackend(dbFile)
    const b = new SqliteLockBackend(dbFile)
    expect(a.acquire('Content/SM_Radio.uasset', 'ticket-1')).toEqual({ ok: true })
    expect(b.acquire('Content/SM_Radio.uasset', 'ticket-2')).toEqual({ ok: false, holder: 'ticket-1' })
    expect(b.list().map(l => l.path)).toEqual(['Content/SM_Radio.uasset'])
    a.release('Content/SM_Radio.uasset', 'ticket-1')
    expect(b.acquire('Content/SM_Radio.uasset', 'ticket-2')).toEqual({ ok: true })
    a.close()
    b.close()
  })
})

describe('P1: SQLite RunStore, OTel telemetry, budgets, replan, and LUFS audio', () => {
  const samplePlan = parsePlan({
    id: 'test-plan', brief: 'test brief', contentRoot: '/Game/Test',
    budget: { maxTokens: 100 },
    tickets: [
      { id: 't-audio', domain: 'audio', title: 'Audio', instructions: 'make sound', produces: [{ id: 'SFX_Ping', kind: 'audio_clip', requires: {} }], consumes: [], after: [], locks: [], review: 'auto', maxRevisions: 1 },
      { id: 't-qa', domain: 'qa', title: 'QA', instructions: 'check', produces: [{ id: 'QA_Ping', kind: 'test_result', requires: { tests: ['ok'] } }], consumes: ['SFX_Ping'], after: [], locks: [], review: 'auto', maxRevisions: 0 },
    ],
  })

  it('persists unlimited events in SqliteRunStore and emits JSONL OTel spans', async () => {
    const dir = tempDir()
    const store = new SqliteRunStore(dir)
    const traces = new TraceCollector({ file: join(dir, 'traces.jsonl') })
    const plan = parsePlan(JSON.parse(readFileSync(join(process.cwd(), 'examples/vintage-radio/plan.json'), 'utf8')))
    const orch = new Orchestrator({
      plan, store, executor: new SimulatedExecutor({ delayMs: 0 }), ingestor: new SimulatedIngestor(),
      pools: new Pools({ unreal: 1 }), locks: new LockManager(new MemoryLockBackend()),
      poolOf: d => d === 'unreal' || d === 'qa' ? 'unreal' : d, telemetry: traces,
    })
    await orch.runUntilIdle()
    for (const t of Object.values(orch.run.tickets)) if (t.state === 'review') orch.approve(t.id)
    await orch.runUntilIdle()
    expect(store.queryEvents().length).toBeGreaterThan(10)
    expect(traces.spans.length).toBeGreaterThan(0)
    expect(existsSync(join(dir, 'traces.jsonl'))).toBe(true)
    store.close()
  })

  it('enforces plan token/cost budgets and pauses remaining work', async () => {
    const tracker = new BudgetTracker({ maxTokens: 100, maxCostUsd: 0.5 })
    tracker.record({ inputTokens: 60, outputTokens: 50, costUsd: 0.1 })
    expect(tracker.exceeded()).toContain('token budget exceeded')

    const dir = tempDir()
    const store = new SqliteRunStore(dir)
    const orch = new Orchestrator({
      plan: samplePlan, store,
      executor: {
        async run(job) {
          mkdirSync(join(job.dir, 'export'), { recursive: true })
          writeFileSync(join(job.dir, 'export/SFX_Ping.wav'), writeWav16(radioStatic(1, 48000), 48000))
          return {
            status: 'ready', summary: 'done', usage: { inputTokens: 80, outputTokens: 40, costUsd: 0.01 },
            assets: [{ id: 'SFX_Ping', kind: 'audio_clip', files: [{ path: 'export/SFX_Ping.wav', role: 'export' }], facts: {}, provenance: { method: 'procedural', tool: 'synth', recipe: 'r.py', license: 'MIT' } }],
          }
        },
      },
      pools: new Pools(), locks: new LockManager(new MemoryLockBackend()), poolOf: d => d,
    })
    const run = await orch.runUntilIdle()
    expect(run.tickets['t-audio']!.state).toBe('done')
    expect(run.tickets['t-qa']!.state).toBe('attention')
    expect(run.tickets['t-qa']!.attention).toContain('token budget exceeded')
    store.close()
  })

  it('incrementally replans without invalidating unchanged tickets', () => {
    const dir = tempDir()
    const store = new SqliteRunStore(dir)
    const orch = new Orchestrator({
      plan: samplePlan, store, executor: new SimulatedExecutor({ delayMs: 0 }),
      pools: new Pools(), locks: new LockManager(new MemoryLockBackend()), poolOf: d => d,
    })
    orch.run.tickets['t-audio']!.state = 'done'
    const updated = parsePlan({
      ...samplePlan,
      tickets: [
        samplePlan.tickets[0]!,
        { ...samplePlan.tickets[1]!, instructions: 'updated QA check' },
      ],
    })
    const diff = orch.replan(updated)
    expect(diff.kept).toEqual(['t-audio'])
    expect(diff.invalidated).toEqual(['t-qa'])
    expect(orch.run.tickets['t-audio']!.state).toBe('done')
    expect(orch.run.tickets['t-qa']!.state).toBe('waiting')
    store.close()
  })

  it('measures ITU-R BS.1770 LUFS and truePeakDb and enforces audio.lufs contract', () => {
    const dir = tempDir()
    const wav = writeWav16(radioStatic(1.5, 48000, { rmsDb: -18, peakDb: -3 }), 48000)
    const facts = readWav(wav)
    expect(Number.isFinite(facts.lufs)).toBe(true)
    expect(Number.isFinite(facts.truePeakDb)).toBe(true)
    expect(facts.lufs).toBeGreaterThan(-30)
    expect(facts.lufs).toBeLessThan(-8)

    writeFileSync(join(dir, 'SFX_Test.wav'), wav)
    const spec = AssetSpec.parse({ id: 'SFX_Test', kind: 'audio_clip', requires: { lufsDb: [-12, -6] } })
    const checked = checkAsset(spec, {
      id: 'SFX_Test', kind: 'audio_clip', files: [{ path: 'SFX_Test.wav', role: 'export' }],
      facts: {}, provenance: { method: 'procedural', tool: 'synth', recipe: 'r.py', license: 'MIT' },
    }, { dir })
    expect(checked.violations.some(v => v.rule === 'audio.lufs')).toBe(true)
  })
})

describe('P2: ComfyUI adapter, provenance manifests, VLM QA, and 3D starter template', () => {
  it('generates reference images via ComfyUI /prompt, /history, and /view', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const calls: string[] = []
    const img = await generateImage({ provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', model: 'flux.safetensors' }, 'hero turnaround', {
      fetch: async (url) => {
        calls.push(url)
        if (url.endsWith('/prompt')) return { ok: true, status: 200, text: async () => '', json: async () => ({ prompt_id: 'pid-42' }), arrayBuffer: async () => new ArrayBuffer(0) }
        if (url.includes('/history/pid-42')) return { ok: true, status: 200, text: async () => '', json: async () => ({ 'pid-42': { outputs: { '7': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } }), arrayBuffer: async () => new ArrayBuffer(0) }
        return { ok: true, status: 200, text: async () => '', json: async () => ({}), arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) }
      },
    })
    expect(img.equals(png)).toBe(true)
    expect(calls[0]).toContain('/prompt')
    expect(calls[1]).toContain('/history/pid-42')
    expect(calls[2]).toContain('/view?filename=out.png')
  })

  it('writes and validates standardized provenance sidecar manifests', () => {
    const dir = tempDir()
    const asset = join(dir, 'hero.png')
    writeFileSync(asset, Buffer.from('fake-png-bytes'))
    const { manifest } = writeProvenance(asset, {
      assetId: 'SPR_Hero', file: 'hero.png', method: 'generative', tool: 'comfyui', model: 'flux', prompt: 'pixel hero', license: 'proprietary',
    })
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.promptHash).toMatch(/^[0-9a-f]{64}$/)
    expect(readProvenance(asset)?.assetId).toBe('SPR_Hero')
  })

  it('runs advisory VLM visual QA review against a preview image', async () => {
    const img = join(tempDir(), 'preview.png')
    writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const critique = await reviewVisualAsset(img, 'Clean silhouette, no clipping', { provider: 'openai' }, {
      env: { OPENAI_API_KEY: 'test-key' },
      fetch: async () => ({
        ok: true, status: 200, text: async () => '',
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ pass: true, score: 9, summary: 'Crisp silhouette', issues: [] }) } }] }),
      }),
    })
    expect(critique).toEqual({ pass: true, score: 9, summary: 'Crisp silhouette', issues: [] })
  })

  it('creates a playable 3D Godot starter project via godot-3d-starter template', () => {
    const folder = join(tempDir(), 'my_3d_game')
    const made = createProject(defaultTemplatesDir(join(process.cwd(), 'src', 'studio')), {
      title: 'Sky Blade', pitch: 'A 3D action adventure', folder, template: 'godot-3d-starter',
    })
    expect(existsSync(join(made.project, 'project.godot'))).toBe(true)
    expect(existsSync(join(made.project, 'scenes', 'main.tscn'))).toBe(true)
    expect(existsSync(join(made.project, 'scripts', 'main.gd'))).toBe(true)
    expect(existsSync(join(made.project, 'scripts', 'player_controller.gd'))).toBe(true)
    expect(readFileSync(join(made.project, 'scenes', 'main.tscn'), 'utf8')).toContain('SpringArm3D')
    expect(readFileSync(join(made.project, 'project.godot'), 'utf8')).toContain('Sky Blade')
  })

  it('auto-emits provenance sidecars from studio_paint and studio_sound', async () => {
    const project = tempDir()
    const server = createHarnessServer({ projectDir: project })
    const client = new Client({ name: 'test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    await client.callTool({ name: 'studio_new_project', arguments: { title: 'Prov Test', folder: project } })
    await client.callTool({
      name: 'studio_paint',
      arguments: { file: 'art/hero.png', rows: ['##', '##'], palette: { '#': '#ff0000' }, project },
    })
    await client.callTool({ name: 'studio_sound', arguments: { name: 'hit', preset: 'hit', project } })
    expect(readProvenance(join(project, 'art', 'hero.png'))?.tool).toBe('studio_paint')
    expect(readProvenance(join(project, 'audio', 'hit.wav'))?.tool).toBe('studio_sound')
    await client.close()
  })
})

