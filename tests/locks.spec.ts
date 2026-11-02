import { describe, expect, it } from 'vitest'
import { LockManager, MemoryLockBackend, PerforceLockBackend, type CommandRunner } from '../src/locks/index.ts'

describe('LockManager', () => {
  it('takes all locks or none, and releases on the first refusal', () => {
    const locks = new LockManager(new MemoryLockBackend())
    expect(locks.acquireAll('a', ['x.blend']).ok).toBe(true)
    const refused = locks.acquireAll('b', ['w.wav', 'x.blend'])
    expect(refused).toEqual({ ok: false, path: 'x.blend', holder: 'ticket a' })
    expect(locks.held().map(l => l.path)).toEqual(['x.blend']) // w.wav was rolled back
    locks.releaseAll('a')
    expect(locks.acquireAll('b', ['w.wav', 'x.blend']).ok).toBe(true)
  })

  it('keeps locks a ticket already held when a later acquisition fails', () => {
    const locks = new LockManager(new MemoryLockBackend())
    locks.acquireAll('a', ['a.uasset'])
    locks.acquireAll('b', ['z.uasset'])
    expect(locks.acquireAll('a', ['a.uasset', 'z.uasset']).ok).toBe(false)
    expect(locks.held().map(l => `${l.path}:${l.ticketId}`)).toEqual(['a.uasset:a', 'z.uasset:b'])
  })

  it('mirrors locks to Perforce and backs out of a refused lock', () => {
    const calls: string[] = []
    const run: CommandRunner = (_, args) => {
      calls.push(args.join(' '))
      if (args.includes('lock') && args.includes('taken.uasset')) return { status: 0, stdout: '', stderr: 'taken.uasset - already locked by artist1' }
      return { status: 0, stdout: '', stderr: '' }
    }
    const locks = new LockManager(new PerforceLockBackend({ run }))
    expect(locks.acquireAll('t', ['free.uasset']).ok).toBe(true)
    expect(locks.acquireAll('u', ['taken.uasset'])).toEqual({ ok: false, path: 'taken.uasset', holder: 'artist1' })
    expect(calls).toEqual(['-ztag edit free.uasset', 'lock free.uasset', '-ztag edit taken.uasset', 'lock taken.uasset', 'revert -k taken.uasset'])
  })
})
