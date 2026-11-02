import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentCliExecutor } from '../src/executors/agent-cli.ts'
import { gooseExtensions, gooseRecipe } from '../src/executors/goose.ts'
import { renderWorkerPrompt } from '../src/executors/prompt.ts'
import type { Job } from '../src/core/ports.ts'
import { allowedTools, loadPresets, loadProfile, resolvePreset, type Profile } from '../src/presets/index.ts'
import { LlmPlanner, type ChatModel } from '../src/planner/index.ts'
import { radioPlan, tempDir } from './fixtures.ts'

const ROOT = resolve(import.meta.dirname, '..')
const presets = loadPresets(join(ROOT, 'presets'))
const workstation = loadProfile(join(ROOT, 'profiles/workstation.example.json'))

function job(ticketId: string, dir: string): Job {
  const plan = radioPlan()
  return { plan, ticket: plan.tickets.find(t => t.id === ticketId)!, assignmentId: `${ticketId}-a1`, revision: 0, dir, inputs: [],
    feedback: [{ asset: 'SM_VintageRadio', rule: 'collision.target', message: 'hull named for the wrong mesh' }], notes: ['Answer: keep the dials'], signal: new AbortController().signal }
}

describe('presets', () => {
  it('has one preset per domain, each resolvable on the example workstation', () => {
    expect([...presets.keys()].sort()).toEqual(['audio', 'blender', 'qa', 'texture', 'unreal'])
    const blender = resolvePreset(presets.get('blender')!, workstation, {})
    expect(blender.mcpConfig.mcpServers.blender).toEqual({ command: 'uvx', args: ['blender-mcp'], env: { BLENDER_HOST: '127.0.0.1', BLENDER_PORT: '9876' } })
    expect(blender.env.BLENDER_BIN).toContain('Blender 4.3')
  })

  it('names every missing variable', () => {
    const bare: Profile = { name: 'bare', os: 'linux', vars: {}, pools: {}, locks: { backend: 'memory' } }
    expect(() => resolvePreset(presets.get('unreal')!, bare, {})).toThrow('needs UNREAL_MCP_URL, UNREAL_PROJECT, UNREAL_EDITOR_CMD, HARNESS_DCC_DIR')
  })

  it('maps generic tool names to the agent\'s and adds MCP servers', () => {
    expect(allowedTools(presets.get('blender')!, workstation)).toEqual(['Bash', 'Edit', 'Write', 'Glob', 'Grep', 'Read', 'mcp__blender'])
  })
})

describe('worker prompt', () => {
  it('inlines the specs, the feedback and people\'s notes', () => {
    const prompt = renderWorkerPrompt(job('vintage-radio-model', '/work/model'), presets.get('blender')!, ROOT)
    expect(prompt).toContain('UCX_<asset id>_01')
    expect(prompt).toContain('"maxTriangles": 6000')
    expect(prompt).toContain('`collision.target` SM_VintageRadio: hull named for the wrong mesh')
    expect(prompt).toContain('- Answer: keep the dials')
    expect(prompt).toContain('`p4 submit`')
  })
})

describe('AgentCliExecutor', () => {
  it('launches the agent with the prompt and MCP config, and reads its result', async () => {
    const dir = tempDir()
    const agent = join(dir, 'fake-agent.mjs')
    writeFileSync(agent, `import { writeFileSync, readFileSync } from 'node:fs'
const [mcp, tools] = process.argv.slice(2)
const config = JSON.parse(readFileSync(mcp, 'utf8'))
writeFileSync(process.env.HARNESS_RESULT, JSON.stringify({ status: 'blocked', summary: tools + ' ' + Object.keys(config.mcpServers).join(','), question: 'which era?' }))
`)
    chmodSync(agent, 0o755)
    const profile: Profile = { ...workstation, agent: { ...workstation.agent!, command: [process.execPath, agent, '{mcpConfig}', '{tools}'] } }
    const result = await new AgentCliExecutor({ presets, profile, repoRoot: ROOT }).run(job('vintage-radio-model', dir))
    expect(result).toEqual({ status: 'blocked', summary: 'Bash,Edit,Write,Glob,Grep,Read,mcp__blender blender', question: 'which era?', assets: [] })
    expect(readFileSync(join(dir, 'PROMPT.vintage-radio-model-a1.md'), 'utf8')).toContain('Model SM_VintageRadio')
  })

  it('fails honestly when the agent writes no result', async () => {
    const dir = tempDir()
    const profile: Profile = { ...workstation, agent: { ...workstation.agent!, command: [process.execPath, '-e', 'console.log("did nothing")'] } }
    const result = await new AgentCliExecutor({ presets, profile, repoRoot: ROOT }).run(job('vintage-radio-model', dir))
    expect(result.status).toBe('failed')
    expect(result.summary).toContain('without writing result.json')
  })
})

describe('goose', () => {
  it('maps preset MCP servers onto recipe extensions and requires the report shape', () => {
    const resolved = resolvePreset(presets.get('unreal')!, workstation, {})
    expect(gooseExtensions(resolved.mcpConfig.mcpServers)).toEqual([
      { type: 'builtin', name: 'developer', timeout: 300 },
      { type: 'streamable_http', name: 'unreal', uri: 'http://127.0.0.1:8000/mcp', headers: {}, timeout: 600 },
    ])
    const recipe = gooseRecipe({ preset: resolved.preset, prompt: 'do it', promptFile: '', mcpConfig: '', mcpServers: resolved.mcpConfig.mcpServers, env: {} }, 'Blueprint BP_VintageRadio')
    expect(recipe).toMatchObject({ title: 'Blueprint BP_VintageRadio', instructions: 'do it', response: { json_schema: { required: ['status', 'summary', 'assets'] } } })
  })
})

describe('LlmPlanner', () => {
  it('sends the checker\'s problems back to the model and accepts the repaired plan', async () => {
    const good = readFileSync(join(ROOT, 'examples/vintage-radio/plan.json'), 'utf8')
    const bad = JSON.parse(good)
    bad.tickets[2].produces[0].id = 'RadioStatic'
    const answers = [JSON.stringify(bad), `\`\`\`json\n${good}\n\`\`\``]
    const seen: string[] = []
    const model: ChatModel = { complete: async messages => { seen.push(messages.at(-1)!.content); return answers.shift()! } }
    const plan = await new LlmPlanner({ model, repoRoot: ROOT }).plan('a vintage radio that plays static')
    expect(plan.id).toBe('vintage-radio')
    expect(seen[1]).toContain('RadioStatic must start with SFX_')
  })
})
