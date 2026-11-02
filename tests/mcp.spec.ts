import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { writeWav16 } from '../src/contracts/wav.ts'
import { radioStatic } from '../src/executors/simulated.ts'
import { FileLockBackend } from '../src/locks/index.ts'
import { createHarnessServer } from '../src/mcp/server.ts'
import { tempDir } from './fixtures.ts'

async function connect(projectDir: string) {
  const server = createHarnessServer({ projectDir })
  const client = new Client({ name: 'test', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> }
    return { text: result.content[0]!.text, error: !!result.isError, data: result.structuredContent }
  }
  return { client, call }
}

const brief = { name: 'VintageRadio', description: 'a 1940s valve radio', sizeCm: [40, 22, 28], maxTriangles: 6000,
  sound: { name: 'RadioStatic', description: 'AM static' }, interaction: 'toggle static', placement: { map: '/Game/Maps/Apartment', location: [0, 0, 0] } }

describe('harness MCP server', () => {
  it('lists its tools with instructions for the agent', async () => {
    const { client } = await connect(tempDir())
    const { tools } = await client.listTools()
    expect(tools.map(tool => tool.name).sort()).toEqual(['harness_check_asset', 'harness_conventions', 'harness_lock', 'harness_locks', 'harness_measure_audio',
      'harness_plan_prop', 'harness_plan_save', 'harness_ticket', 'harness_unlock', 'harness_validate'])
    expect(client.getInstructions()).toContain('harness_validate')
  })

  it('plans a prop, hands out a ticket, and validates what the agent delivered', async () => {
    const project = tempDir()
    const { call } = await connect(project)
    const planned = await call('harness_plan_prop', { brief })
    expect(planned.text).toContain('wave 1 (parallel): vintage-radio-model, vintage-radio-audio')
    const ticket = await call('harness_ticket', { plan: 'vintage-radio', ticket: 'vintage-radio-audio' })
    const dir = (ticket.data as { dir: string }).dir
    mkdirSync(join(dir, 'export'), { recursive: true })
    writeFileSync(join(dir, 'export/SFX_RadioStatic.wav'), writeWav16(radioStatic(3, 48000, { loop: true, rmsDb: -6, peakDb: 0 }), 48000))
    const result = { status: 'ready', summary: 'done', assets: [
      { id: 'SFX_RadioStatic', kind: 'audio_clip', files: [{ path: 'export/SFX_RadioStatic.wav', role: 'export' }], facts: {}, provenance: { method: 'procedural', tool: 'synth', recipe: 'recipe/synth.py', license: 'proprietary' } },
    ] }
    const checked = await call('harness_validate', { plan: 'vintage-radio', ticket: 'vintage-radio-audio', result })
    expect(checked.text).toContain('[audio.peak]')
    expect(checked.text).toContain('[audio.loudness]')
    expect(checked.text).toContain('[delivery.missing] Play_RadioStatic')
  })

  it('reports plan problems as a tool error the model can fix', async () => {
    const { call } = await connect(tempDir())
    const saved = await call('harness_plan_save', { plan: { id: 'xx', brief: 'b', tickets: [{ id: 'aa', domain: 'audio', title: 't', instructions: 'i', produces: [{ id: 'SM_Box', kind: 'static_mesh', requires: { maxTriangles: 10 } }] }] } })
    expect(saved.error).toBe(true)
    expect(saved.text).toContain('aa (audio) cannot produce static_mesh SM_Box')
  })

  it('shares all-or-nothing locks between sessions through the lock file', async () => {
    const project = tempDir()
    const first = await connect(project)
    const second = await connect(project)
    expect((await first.call('harness_lock', { paths: ['Content/BP_Radio.uasset'], owner: 'blueprint' })).error).toBe(false)
    const refused = await second.call('harness_lock', { paths: ['Art/SM_Radio.blend', 'Content/BP_Radio.uasset'], owner: 'model' })
    expect(refused.text).toContain('locked by blueprint; nothing was locked')
    expect(new FileLockBackend(join(project, '.harness/locks.json')).list().map(lock => lock.path)).toEqual(['Content/BP_Radio.uasset'])
    await first.call('harness_unlock', { owner: 'blueprint' })
    expect((await second.call('harness_lock', { paths: ['Art/SM_Radio.blend', 'Content/BP_Radio.uasset'], owner: 'model' })).error).toBe(false)
    expect((await second.call('harness_locks')).text).toContain('Art/SM_Radio.blend: model')
  })

  it('measures audio and explains conventions', async () => {
    const project = tempDir()
    writeFileSync(join(project, 'a.wav'), writeWav16(radioStatic(1, 48000), 48000))
    const { call } = await connect(project)
    expect((await call('harness_measure_audio', { path: 'a.wav' })).text).toContain('sampleRate: 48000')
    expect((await call('harness_conventions', { kind: 'static_mesh' })).text).toContain('UCX_<id>_NN')
  })
})
