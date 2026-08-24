import { describe, it, expect } from 'vitest'
import { readReplica } from '../src/replicas.js'

// A fake Prisma-ish client. Each op records which client served it via `tag`.
function fakeClient(tag: string) {
  const calls: string[] = []
  const model = (name: string) => ({
    findMany: async () => ({ served: tag, op: `${name}.findMany` }),
    count: async () => ({ served: tag }),
    create: async () => ({ served: tag, op: `${name}.create` }),
    update: async () => ({ served: tag }),
  })
  return {
    calls,
    project: model('project'),
    user: model('user'),
    $queryRaw: async () => ({ served: tag, kind: 'queryRaw' }),
    $executeRaw: async () => ({ served: tag, kind: 'executeRaw' }),
    $transaction: async (fn: () => unknown) => ({ served: tag, kind: 'tx', r: await fn() }),
  }
}

describe('readReplica', () => {
  it('routes model reads to replicas and writes to the primary', async () => {
    const primary = fakeClient('primary')
    const r1 = fakeClient('r1')
    const db = readReplica({ primary, replicas: [r1] })

    expect((await db.project.findMany()).served).toBe('r1')
    expect((await db.project.count()).served).toBe('r1')
    expect((await db.project.create()).served).toBe('primary')
    expect((await db.project.update()).served).toBe('primary')
  })

  it('round-robins reads across replicas', async () => {
    const db = readReplica({
      primary: fakeClient('primary'),
      replicas: [fakeClient('r1'), fakeClient('r2')],
    })
    const served = []
    for (let i = 0; i < 4; i++) served.push((await db.project.findMany()).served)
    expect(served).toEqual(['r1', 'r2', 'r1', 'r2'])
  })

  it('keeps $queryRaw on the primary by default (raw can mutate); opt-in routes it to a replica', async () => {
    const safe = readReplica({ primary: fakeClient('primary'), replicas: [fakeClient('r1')] })
    expect((await safe.$queryRaw()).served).toBe('primary') // secure default
    expect((await safe.$executeRaw()).served).toBe('primary')
    expect((await safe.$transaction(async () => 1)).served).toBe('primary')

    const optedIn = readReplica({
      primary: fakeClient('primary'),
      replicas: [fakeClient('r1')],
      rawReadsOnReplica: true,
    })
    expect((await optedIn.$queryRaw()).served).toBe('r1')
    expect((await optedIn.$executeRaw()).served).toBe('primary') // still never a replica
  })

  it('extend applies the same extension to primary AND every replica (no un-scoped replica)', async () => {
    const tag = (client: ReturnType<typeof fakeClient>) => {
      // simulate $extends wrapping: mark the client as "scoped"
      return { ...client, scoped: true } as typeof client & { scoped: boolean }
    }
    const db = readReplica({
      primary: fakeClient('primary'),
      replicas: [fakeClient('r1'), fakeClient('r2')],
      extend: tag as never,
    })
    // both a replica read and $primary are the extended (scoped) clients
    expect((db as unknown as { $primary: { scoped?: boolean } }).$primary.scoped).toBe(true)
  })

  it('$primary forces the primary for read-your-writes', async () => {
    const db = readReplica({ primary: fakeClient('primary'), replicas: [fakeClient('r1')] })
    expect((await db.$primary.project.findMany()).served).toBe('primary')
  })

  it('with no replicas everything hits the primary', async () => {
    const db = readReplica({ primary: fakeClient('primary'), replicas: [] })
    expect((await db.project.findMany()).served).toBe('primary')
    expect((await db.project.create()).served).toBe('primary')
    expect((await db.$primary.project.findMany()).served).toBe('primary')
  })

  it('respects extra readOps', async () => {
    const primary = { widget: { search: async () => ({ served: 'primary' }) } }
    const r1 = { widget: { search: async () => ({ served: 'r1' }) } }
    const db = readReplica({ primary, replicas: [r1], readOps: ['search'] })
    expect((await db.widget.search()).served).toBe('r1')
  })
})
