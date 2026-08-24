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

  it('routes $queryRaw to a replica but $executeRaw and $transaction to primary', async () => {
    const db = readReplica({ primary: fakeClient('primary'), replicas: [fakeClient('r1')] })
    expect((await db.$queryRaw()).served).toBe('r1')
    expect((await db.$executeRaw()).served).toBe('primary')
    expect((await db.$transaction(async () => 1)).served).toBe('primary')
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
