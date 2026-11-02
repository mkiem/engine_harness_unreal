import { describe, expect, it } from 'vitest'
import { parsePlan, PlanError, waves } from '../src/core/plan.ts'
import { propPlan } from '../src/planner/index.ts'
import { radioPlan } from './fixtures.ts'

const problems = (input: unknown) => {
  try {
    parsePlan(input)
    return []
  } catch (error) {
    return (error as PlanError).problems
  }
}

describe('plan checks', () => {
  it('accepts the example and runs model and audio in parallel', () => {
    expect(waves(radioPlan())).toEqual([['vintage-radio-model', 'vintage-radio-audio'], ['vintage-radio-texture'], ['vintage-radio-blueprint'], ['vintage-radio-qa']])
  })

  it('reports every structural problem at once', () => {
    const plan = radioPlan()
    const bad = JSON.parse(JSON.stringify(plan))
    bad.tickets[0].produces[0].id = 'Radio' // wrong prefix
    bad.tickets[0].consumes = ['QA_VintageRadio'] // cycle through qa
    bad.tickets[1].domain = 'audio' // texture ticket on the audio domain
    const found = problems(bad)
    expect(found.some(p => p.includes('must start with SM_'))).toBe(true)
    expect(found.some(p => p.includes('cannot produce texture_set'))).toBe(true)
    expect(found.some(p => p.includes('which no ticket produces'))).toBe(true)
  })

  it('finds cycles', () => {
    const plan = JSON.parse(JSON.stringify(radioPlan()))
    plan.tickets[0].after = ['vintage-radio-qa']
    expect(problems(plan).some(p => p.startsWith('dependency cycle'))).toBe(true)
  })

  it('requires an edge for every asset a spec names', () => {
    const plan = JSON.parse(JSON.stringify(radioPlan()))
    const blueprint = plan.tickets.find((t: { id: string }) => t.id === 'vintage-radio-blueprint')
    blueprint.produces[1].requires.actorClass = 'BP_Missing'
    expect(problems(plan)).toContain('PL_VintageRadio names BP_Missing, which no ticket produces')
  })

  it('builds a prop plan without sound or placement', () => {
    const plan = propPlan({ name: 'Crate', description: 'a wooden crate', sizeCm: [60, 60, 60], maxTriangles: 2000, lods: 1, textureResolution: 1024, artReview: true })
    expect(plan.tickets.map(t => t.domain)).toEqual(['blender', 'texture', 'unreal', 'qa'])
    expect(plan.tickets[0]!.review).toBe('human')
  })
})
