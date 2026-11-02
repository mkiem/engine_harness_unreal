/**
 * Tool pools: how many workers may hold a tool at once. A DCC is not a stateless API: one live Unreal Editor holds one
 * project, and a blender-mcp socket talks to one Blender instance. The profile sizes each pool per machine.
 */
export class Pools {
  private readonly sizes: Record<string, number>
  private readonly used = new Map<string, number>()
  private readonly waiters = new Map<string, (() => void)[]>()
  private readonly fallback: number
  constructor(sizes: Record<string, number> = {}, fallback = 1) {
    this.sizes = sizes
    this.fallback = fallback
  }

  size(pool: string): number { return this.sizes[pool] ?? this.fallback }
  inUse(pool: string): number { return this.used.get(pool) ?? 0 }

  /** Takes a slot now, or answers false; for the scheduler, which keeps the ticket queued instead of waiting. */
  tryAcquire(pool: string): boolean {
    if (this.inUse(pool) >= this.size(pool)) return false
    this.used.set(pool, this.inUse(pool) + 1)
    return true
  }

  /** Waits for a slot; for pipeline stages that must finish once started, such as ingest. */
  async acquire(pool: string): Promise<void> {
    if (this.tryAcquire(pool)) return
    if (this.size(pool) <= 0) throw new Error(`pool ${pool} has no slots on this machine`)
    await new Promise<void>(resolve => {
      const list = this.waiters.get(pool) ?? []
      list.push(resolve)
      this.waiters.set(pool, list)
    })
  }

  release(pool: string): void {
    const waiter = this.waiters.get(pool)?.shift()
    if (waiter) return waiter() // hand the slot straight to the waiter
    this.used.set(pool, Math.max(0, this.inUse(pool) - 1))
  }
}
