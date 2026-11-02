import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Plan } from '../src/core/model.ts'
import { parsePlan } from '../src/core/plan.ts'

export const tempDir = (prefix = 'harness-') => mkdtempSync(join(tmpdir(), prefix))
export const radioPlan = (): Plan => parsePlan(JSON.parse(readFileSync(new URL('../examples/vintage-radio/plan.json', import.meta.url), 'utf8')))
