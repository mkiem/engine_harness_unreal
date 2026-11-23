// Measures how much context each group of harness tools costs an agent: the JSON of the tool definitions the MCP
// server sends (name, description, input schema, annotations), in characters and estimated tokens (~4 chars/token).
// Usage: node scripts/tool-budget.ts [--dynamic] [--max-tokens <n>]
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createHarnessServer } from '../src/mcp/server.ts'

const dynamic = process.argv.includes('--dynamic')
const maxIdx = process.argv.indexOf('--max-tokens')
const maxTokens = maxIdx >= 0 ? Number(process.argv[maxIdx + 1]) : undefined

const server = createHarnessServer({ projectDir: mkdtempSync(join(tmpdir(), 'budget-')), dynamicToolsets: dynamic })
const client = new Client({ name: 'budget', version: '1' })
const [a, b] = InMemoryTransport.createLinkedPair()
await Promise.all([server.connect(a), client.connect(b)])
const { tools } = await client.listTools()
const groups = new Map<string, { tools: number; chars: number }>()

const classify = (name: string) => {
  if (name.startsWith('godot_') || name === 'harness_setup_godot_project') return 'Godot'
  if (name.startsWith('unreal_') || name === 'harness_setup_unreal_project') return 'Unreal'
  if (name.startsWith('studio_')) return 'Studio'
  if (name.startsWith('character_')) return 'Character 3D'
  if (name.startsWith('assets_')) return 'Assets'
  return 'Pipeline & Setup'
}

let totalChars = 0
for (const tool of tools) {
  const group = classify(tool.name)
  const entry = groups.get(group) ?? { tools: 0, chars: 0 }
  const len = JSON.stringify(tool).length
  entry.tools++
  entry.chars += len
  totalChars += len
  groups.set(group, entry)
}
const instructions = client.getInstructions()?.length ?? 0
const totalTokens = Math.round((totalChars + instructions) / 4)

console.log(`Mode: ${dynamic ? 'dynamic (initial toolsets)' : 'all toolsets'}\n`)
console.log('| Group | Tools | Characters | ~Tokens |\n| --- | --- | --- | --- |')
for (const [group, { tools: count, chars }] of groups) console.log(`| ${group} | ${count} | ${chars} | ${Math.round(chars / 4)} |`)
console.log(`| Server instructions | | ${instructions} | ${Math.round(instructions / 4)} |`)
console.log(`| **Total** | **${tools.length}** | **${totalChars + instructions}** | **${totalTokens}** |`)
await client.close()

if (maxTokens && totalTokens > maxTokens) {
  console.error(`Tool budget exceeded: ${totalTokens} tokens > limit ${maxTokens}`)
  process.exit(1)
}
