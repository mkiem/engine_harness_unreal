/** Durable run state: one JSON document per run, written atomically after every change, so a crash loses no decision. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PlanRun } from './model.ts'

export class RunStore {
  readonly dir: string
  constructor(dir: string) {
    this.dir = dir
    mkdirSync(join(dir, 'work'), { recursive: true })
  }

  get path(): string { return join(this.dir, 'run.json') }

  ticketDir(ticketId: string): string {
    const dir = join(this.dir, 'work', ticketId)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  load(): PlanRun | undefined {
    return existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) as PlanRun : undefined
  }

  save(run: PlanRun): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(run, null, 2))
    renameSync(tmp, this.path)
  }
}
