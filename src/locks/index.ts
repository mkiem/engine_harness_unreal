/**
 * Asset locks. Binary assets (.blend, .uasset, .umap, .wav) cannot be merged, so two tickets must never write the same
 * one. The host, not the agent, takes every lock a ticket declares before it launches and releases them when it ends:
 * a worker never decides whether to respect a lock.
 *
 * Acquisition is all-or-nothing in sorted path order, which rules out deadlock between tickets that need overlapping sets.
 * A backend mirrors the lock in the studio's version control, so people working by hand see it too.
 */
import { spawnSync } from 'node:child_process'
import type { LockLease } from '../core/model.ts'

export interface LockBackend {
  readonly name: string
  /** Takes the lock for `owner` or answers who holds it. Must be idempotent for the same owner. */
  acquire(path: string, owner: string): { ok: true } | { ok: false; holder: string }
  release(path: string, owner: string): void
}

/** Locks only inside this process: for tests and single-machine dry runs. */
export class MemoryLockBackend implements LockBackend {
  readonly name = 'memory'
  private readonly held = new Map<string, string>()
  acquire(path: string, owner: string) {
    const holder = this.held.get(path)
    if (holder && holder !== owner) return { ok: false as const, holder }
    this.held.set(path, owner)
    return { ok: true as const }
  }
  release(path: string, owner: string) {
    if (this.held.get(path) === owner) this.held.delete(path)
  }
}

/** Runs a command and returns its output; injectable so the VCS backends are testable without p4 or git installed. */
export type CommandRunner = (command: string, args: string[], options?: { cwd?: string }) => { status: number; stdout: string; stderr: string }

export const runCommand: CommandRunner = (command, args, options) => {
  const result = spawnSync(command, args, { cwd: options?.cwd, encoding: 'utf8' })
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? (result.error ? String(result.error) : '') }
}

/**
 * Perforce: `p4 edit` opens the file in the ticket's changelist and `p4 lock` makes it exclusive. Most studios also set
 * the +l filetype on binaries, which makes `edit` itself exclusive; `lock` covers depots that do not.
 * The changelist description names the ticket, so `p4 opened` shows people which agent ticket holds a file.
 */
export class PerforceLockBackend implements LockBackend {
  readonly name = 'perforce'
  private readonly run: CommandRunner
  private readonly cwd?: string
  constructor(options: { run?: CommandRunner; cwd?: string } = {}) {
    this.run = options.run ?? runCommand
    this.cwd = options.cwd
  }
  acquire(path: string, owner: string) {
    const edit = this.run('p4', ['-ztag', 'edit', path], { cwd: this.cwd })
    if (edit.status !== 0 || /exclusive|also opened by|locked by/i.test(edit.stdout + edit.stderr))
      return { ok: false as const, holder: holderOf(edit.stdout + edit.stderr) ?? 'another Perforce user' }
    const lock = this.run('p4', ['lock', path], { cwd: this.cwd })
    if (lock.status !== 0 || /already locked/i.test(lock.stdout + lock.stderr)) {
      this.run('p4', ['revert', '-k', path], { cwd: this.cwd })
      return { ok: false as const, holder: holderOf(lock.stdout + lock.stderr) ?? 'another Perforce user' }
    }
    return { ok: true as const }
  }
  release(path: string) {
    this.run('p4', ['unlock', path], { cwd: this.cwd })
  }
}

/** Git LFS file locking (`git lfs lock`); the file must be tracked as lockable in .gitattributes. */
export class GitLfsLockBackend implements LockBackend {
  readonly name = 'git-lfs'
  private readonly run: CommandRunner
  private readonly cwd?: string
  constructor(options: { run?: CommandRunner; cwd?: string } = {}) {
    this.run = options.run ?? runCommand
    this.cwd = options.cwd
  }
  acquire(path: string) {
    const result = this.run('git', ['lfs', 'lock', '--json', path], { cwd: this.cwd })
    if (result.status === 0) return { ok: true as const }
    // git lfs answers a lock we already own with an error too; treat our own existing lock as success.
    const mine = this.run('git', ['lfs', 'locks', '--verify', '--json', '--path', path], { cwd: this.cwd })
    try {
      const parsed = JSON.parse(mine.stdout) as { ours?: unknown[] }
      if (parsed.ours?.length) return { ok: true as const }
    } catch { /* fall through */ }
    return { ok: false as const, holder: holderOf(result.stderr) ?? 'another Git LFS user' }
  }
  release(path: string) {
    this.run('git', ['lfs', 'unlock', path], { cwd: this.cwd })
  }
}

function holderOf(text: string): string | undefined {
  return /(?:by|owner[: ]+)\s*([\w.@-]+)/i.exec(text)?.[1]
}

export class LockManager {
  private readonly backend: LockBackend
  private readonly leases = new Map<string, LockLease>()
  private readonly now: () => Date
  constructor(backend: LockBackend, now: () => Date = () => new Date()) {
    this.backend = backend
    this.now = now
  }

  get backendName(): string { return this.backend.name }

  /** Takes every path for the ticket, or none: on the first refusal, releases what it took and names the holder. */
  acquireAll(ticketId: string, paths: readonly string[]): { ok: true; leases: LockLease[] } | { ok: false; path: string; holder: string } {
    const sorted = [...new Set(paths)].sort()
    const taken: string[] = []
    for (const path of sorted) {
      const lease = this.leases.get(path)
      if (lease && lease.ticketId !== ticketId) {
        this.rollback(ticketId, taken)
        return { ok: false, path, holder: `ticket ${lease.ticketId}` }
      }
      const result = this.backend.acquire(path, ticketId)
      if (!result.ok) {
        this.rollback(ticketId, taken)
        return { ok: false, path, holder: result.holder }
      }
      if (!lease) {
        // Only locks this call took are rolled back; ones the ticket already held stay held.
        taken.push(path)
        this.leases.set(path, { path, ticketId, backend: this.backend.name, acquiredAt: this.now().toISOString() })
      }
    }
    return { ok: true, leases: sorted.map(path => this.leases.get(path)!) }
  }

  releaseAll(ticketId: string): void {
    for (const [path, lease] of this.leases) {
      if (lease.ticketId !== ticketId) continue
      this.backend.release(path, ticketId)
      this.leases.delete(path)
    }
  }

  /** Re-registers leases loaded from a stored run, after a restart, without asking the backend again. */
  restore(leases: readonly LockLease[]): void {
    for (const lease of leases) this.leases.set(lease.path, lease)
  }

  held(): LockLease[] {
    return [...this.leases.values()]
  }

  private rollback(ticketId: string, paths: string[]) {
    for (const path of paths) {
      const lease = this.leases.get(path)
      if (lease?.ticketId === ticketId) {
        this.backend.release(path, ticketId)
        this.leases.delete(path)
      }
    }
  }
}
