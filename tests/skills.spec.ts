import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { createHarnessServer } from '../src/mcp/server.ts'
import { phaseReports } from '../src/studio/phases.ts'
import { GameDesign } from '../src/studio/design.ts'
import { tempDir } from './fixtures.ts'

const SKILLS = resolve(import.meta.dirname, '..', 'skills')
const skills = readdirSync(SKILLS).filter(name => existsSync(join(SKILLS, name, 'SKILL.md')))
const read = (name: string) => readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8')

describe('the studio skills', () => {
  it('each has a name matching its folder and a description, as agent skills need', () => {
    expect(skills.length).toBeGreaterThanOrEqual(13)
    for (const name of skills) {
      const front = /^---\n([\s\S]*?)\n---\n/.exec(read(name))?.[1]
      expect(front, name).toBeTruthy()
      expect(front).toMatch(new RegExp(`^name: ${name}$`, 'm'))
      expect(/^description: (.{40,})$/m.exec(front!)?.[1], name).toBeTruthy()
    }
  })

  it('cover every phase, and the master skill names every phase skill', () => {
    const phaseSkills = phaseReports(tempDir('skills-'), GameDesign.parse({ title: 'x' })).map(r => r.skill)
    for (const skill of phaseSkills) expect(skills, skill).toContain(skill)
    for (const skill of phaseSkills) expect(read('game-studio')).toContain(skill)
  })

  it('only mention tools the harness has', async () => {
    const server = createHarnessServer({ projectDir: tempDir('skills-mcp-') })
    const client = new Client({ name: 'test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    const tools = new Set((await client.listTools()).tools.map(t => t.name))
    for (const name of skills) {
      for (const [mention] of read(name).matchAll(/\b(?:studio|godot|assets|harness|unreal)_[a-z_]+\b/g)) expect(tools, `${name} mentions ${mention}`).toContain(mention)
    }
  })
})
