// Measures how much context each group of harness tools costs an agent: the JSON of the tool definitions the MCP
// server sends (name, description, input schema), in characters and in estimated tokens (about 4 characters each).
// Usage: node scripts/tool-budget.ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createHarnessServer } from '../src/mcp/server.ts'

const server = createHarnessServer({ projectDir: mkdtempSync(join(tmpdir(), 'budget-')) })
const client = new Client({ name: 'budget', version: '1' })
const [a, b] = InMemoryTransport.createLinkedPair()
await Promise.all([server.connect(a), client.connect(b)])
const { tools } = await client.listTools()
const groups = new Map<string, { tools: number; chars: number }>()
for (const tool of tools) {
  const group = tool.name.startsWith('godot_') || tool.name === 'harness_setup_godot_project' ? 'Godot'
    : tool.name.startsWith('unreal_') || tool.name === 'harness_setup_unreal_project' ? 'Unreal'
      : 'Shared (pipeline, locks, setup)'
  const entry = groups.get(group) ?? { tools: 0, chars: 0 }
  entry.tools++
  entry.chars += JSON.stringify(tool).length
  groups.set(group, entry)
}
const instructions = client.getInstructions()?.length ?? 0
console.log('| Group | Tools | Characters | ~Tokens |\n| --- | --- | --- | --- |')
for (const [group, { tools: count, chars }] of groups) console.log(`| ${group} | ${count} | ${chars} | ${Math.round(chars / 4)} |`)
console.log(`| Server instructions | | ${instructions} | ${Math.round(instructions / 4)} |`)
await client.close()
