/**
 * Durable run state:
 * - `RunStore`: atomic JSON document (`run.json`) for simple single-process runs.
 * - `SqliteRunStore`: Node 22+ `node:sqlite` (WAL mode) with unlimited append-only `events` log,
 *   replayable `snapshots`, and concurrent read safety.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { PlanRun, RunEvent } from './model.ts'

export interface StoreLike {
  readonly dir: string
  readonly path: string
  ticketDir(ticketId: string): string
  load(): PlanRun | undefined
  save(run: PlanRun): void
  appendEvent?(event: RunEvent): void
}

export class RunStore implements StoreLike {
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

export class SqliteRunStore implements StoreLike {
  readonly dir: string
  readonly path: string
  private readonly db: DatabaseSync

  constructor(dir: string) {
    this.dir = dir
    mkdirSync(join(dir, 'work'), { recursive: true })
    this.path = join(dir, 'run.db')
    this.db = new DatabaseSync(this.path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        plan_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        ticket_id TEXT,
        type TEXT NOT NULL,
        detail TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_ticket ON events(ticket_id);
    `)
  }

  ticketDir(ticketId: string): string {
    const dir = join(this.dir, 'work', ticketId)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  load(): PlanRun | undefined {
    const row = this.db.prepare('SELECT json FROM state WHERE id = 1').get() as { json: string } | undefined
    return row ? JSON.parse(row.json) as PlanRun : undefined
  }

  save(run: PlanRun): void {
    this.db.prepare(`
      INSERT INTO state (id, plan_id, updated_at, json) VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET plan_id = excluded.plan_id, updated_at = excluded.updated_at, json = excluded.json
    `).run(run.planId, run.updatedAt, JSON.stringify(run))
  }

  appendEvent(event: RunEvent): void {
    this.db.prepare('INSERT INTO events (at, ticket_id, type, detail) VALUES (?, ?, ?, ?)')
      .run(event.at, event.ticketId ?? null, event.type, event.detail)
  }

  queryEvents(ticketId?: string): RunEvent[] {
    const rows = (ticketId
      ? this.db.prepare('SELECT at, ticket_id, type, detail FROM events WHERE ticket_id = ? ORDER BY seq').all(ticketId)
      : this.db.prepare('SELECT at, ticket_id, type, detail FROM events ORDER BY seq').all()) as { at: string; ticket_id: string | null; type: string; detail: string }[]
    return rows.map(r => ({ at: r.at, ...(r.ticket_id ? { ticketId: r.ticket_id } : {}), type: r.type, detail: r.detail }))
  }

  close(): void {
    this.db.close()
  }
}
