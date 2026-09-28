import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createApp, ctx, ensureMetadata, runWithContext } from '@basaltkit/core'
import { defineEvent, EventBus } from '@basaltkit/events'
import {
  defineJob,
  DuplicateJobError,
  JobContextError,
  JobSignatureError,
  QUEUE,
  QueueManager,
  queuedOn,
  queuePlugin,
  SyncQueueDriver,
  type AddJobOptions,
  type JobExecutor,
  type QueueDriver,
} from '../src/index.js'

/**
 * A broker stand-in: `add` stores the envelope as JSON (like every real
 * driver), `deliver` hands a message to the worker. Tests can also inject a
 * crafted message — what anyone with write access to the broker can do.
 */
class BrokerDriver implements QueueDriver {
  readonly name = 'broker'
  readonly messages: { jobName: string; body: string }[] = []
  private executor: JobExecutor | undefined
  setExecutor(executor: JobExecutor): void {
    this.executor = executor
  }
  async add(_queue: string, jobName: string, data: unknown, _options: AddJobOptions): Promise<void> {
    this.messages.push({ jobName, body: JSON.stringify(data) })
  }
  async deliver(index = this.messages.length - 1): Promise<void> {
    const message = this.messages[index]!
    await this.executor!(message.jobName, JSON.parse(message.body))
  }
  async inject(jobName: string, envelope: unknown): Promise<void> {
    await this.executor!(jobName, JSON.parse(JSON.stringify(envelope)))
  }
  startWorker(): void {}
  async close(): Promise<void> {}
}

const KEY = 'k'.repeat(32)
const OTHER_KEY = 'o'.repeat(32)

const probe = (seen: Record<string, unknown>[], name = 'probe') =>
  defineJob({
    name,
    handle: () => {
      const context = ctx()
      seen.push({ ...context })
    },
  })

describe('FA-062: the worker restores a validated, minimal context', () => {
  it('drops every field outside the allowlist — a broker writer cannot inject arbitrary context', async () => {
    const driver = new BrokerDriver()
    const manager = new QueueManager(driver)
    const seen: Record<string, unknown>[] = []
    manager.register(probe(seen))

    await driver.inject('probe', {
      payload: {},
      context: {
        requestId: 'req-1',
        isAdmin: true,
        container: { evil: true },
        user: { id: 'root', roles: ['super-admin'] },
      },
    })
    expect(seen).toEqual([{ requestId: 'req-1' }])
  })

  it('restores the dispatching user as a minimal actor (id only) for audit and permissions', async () => {
    const driver = new BrokerDriver()
    const manager = new QueueManager(driver)
    const seen: Record<string, unknown>[] = []
    const job = probe(seen)
    manager.register(job)

    await runWithContext(
      { requestId: 'req-2', tenant: { id: 'acme', plan: 'pro' }, user: { id: 'u-1', email: 'a@x', roles: ['owner'] } },
      () => job.dispatch({}),
    )
    await driver.deliver()
    expect(seen).toEqual([
      { requestId: 'req-2', tenant: { id: 'acme' }, userId: 'u-1', user: { id: 'u-1' } },
    ])
  })

  it.each([
    ['a tenant id outside the grammar', { tenant: { id: '../other' } }],
    ['the reserved global scope', { tenant: { id: 'global' } }],
    ['a non-string tenant id', { tenant: { id: 7 } }],
    ['a tenant that is not an object', { tenant: 'acme' }],
    ['tenant and tenantId that disagree', { tenant: { id: 'acme' }, tenantId: 'globex' }],
    ['a non-string userId', { userId: { id: 'x' } }],
    ['a userId with control characters', { userId: 'u-1\nforged' }],
    ['a context that is not an object', 'tenant=acme'],
  ])('fails closed on %s — the handler never runs', async (_label, context) => {
    const driver = new BrokerDriver()
    const manager = new QueueManager(driver)
    const seen: Record<string, unknown>[] = []
    manager.register(probe(seen))

    await expect(driver.inject('probe', { payload: {}, context })).rejects.toBeInstanceOf(JobContextError)
    expect(seen).toEqual([])
  })

  it('honors a custom tenant-id grammar', async () => {
    const driver = new BrokerDriver()
    const manager = new QueueManager(driver, { validateTenantId: (id) => /^[A-Z]{3}$/.test(id) })
    const seen: Record<string, unknown>[] = []
    manager.register(probe(seen))

    await driver.inject('probe', { payload: {}, context: { tenant: { id: 'ACM' } } })
    await expect(driver.inject('probe', { payload: {}, context: { tenant: { id: 'acme' } } })).rejects.toBeInstanceOf(
      JobContextError,
    )
    expect(seen).toEqual([{ tenant: { id: 'ACM' } }])
  })

  it('drops (does not reject) a malformed informational field', async () => {
    const driver = new BrokerDriver()
    const manager = new QueueManager(driver)
    const seen: Record<string, unknown>[] = []
    manager.register(probe(seen))
    await driver.inject('probe', { payload: {}, context: { requestId: 'x'.repeat(1000), traceId: 't-1' } })
    expect(seen).toEqual([{ traceId: 't-1' }])
  })
})

describe('FA-062: signed envelopes (signingKey)', () => {
  const setup = (signingKey: string | string[] = KEY) => {
    const driver = new BrokerDriver()
    const manager = new QueueManager(driver, { signingKey })
    const seen: Record<string, unknown>[] = []
    const job = probe(seen)
    manager.register(job)
    return { driver, manager, seen, job }
  }

  it('a signed job round-trips through the broker and runs', async () => {
    const { driver, seen, job } = setup()
    await runWithContext({ tenant: { id: 'acme' } }, () => job.dispatch({}))
    expect(JSON.parse(driver.messages[0]!.body).sig).toMatch(/^v1:/)
    await driver.deliver()
    expect(seen).toEqual([{ tenant: { id: 'acme' } }])
  })

  it('rejects an unsigned message — writing to the broker is no longer enough', async () => {
    const { driver, seen } = setup()
    await expect(
      driver.inject('probe', { payload: {}, context: { tenant: { id: 'victim' } } }),
    ).rejects.toBeInstanceOf(JobSignatureError)
    expect(seen).toEqual([])
  })

  it('rejects a signed message whose context was altered on the broker', async () => {
    const { driver, seen, job } = setup()
    await runWithContext({ tenant: { id: 'acme' }, user: { id: 'u-1' } }, () => job.dispatch({}))
    const envelope = JSON.parse(driver.messages[0]!.body)
    envelope.context.tenant.id = 'victim'
    await expect(driver.inject('probe', envelope)).rejects.toBeInstanceOf(JobSignatureError)
    expect(seen).toEqual([])
  })

  it('binds the signature to the job name — a signed envelope cannot be replayed as another job', async () => {
    const { driver, manager, seen, job } = setup()
    const other: Record<string, unknown>[] = []
    manager.register(probe(other, 'dangerous'))
    await job.dispatch({})
    const envelope = JSON.parse(driver.messages[0]!.body)
    await expect(driver.inject('dangerous', envelope)).rejects.toBeInstanceOf(JobSignatureError)
    expect(other).toEqual([])
    expect(seen).toEqual([])
  })

  it('rotates: the first key signs, every key verifies', async () => {
    const old = setup(OTHER_KEY)
    await old.job.dispatch({})
    const rotated = setup([KEY, OTHER_KEY])
    await rotated.driver.inject('probe', JSON.parse(old.driver.messages[0]!.body))
    expect(rotated.seen).toHaveLength(1)
    // …and a worker that dropped the old key rejects it.
    const dropped = setup(KEY)
    await expect(dropped.driver.inject('probe', JSON.parse(old.driver.messages[0]!.body))).rejects.toBeInstanceOf(
      JobSignatureError,
    )
  })

  it('refuses a key shorter than 32 bytes', () => {
    expect(() => new QueueManager(new BrokerDriver(), { signingKey: 'short' })).toThrow(/at least 32 bytes/)
  })

  it('queuePlugin forwards signingKey to the manager', async () => {
    const driver = new BrokerDriver()
    const seen: Record<string, unknown>[] = []
    const job = probe(seen)
    const app = await createApp({ plugins: [queuePlugin({ driver, jobs: [job], signingKey: KEY })] }).boot()
    await expect(driver.inject('probe', { payload: {} })).rejects.toBeInstanceOf(JobSignatureError)
    await job.dispatch({})
    await driver.deliver()
    expect(seen).toHaveLength(1)
    expect(app.container.get(QUEUE)).toBeInstanceOf(QueueManager)
    await app.shutdown()
  })
})

describe('FA-063: job names are unique per QueueManager', () => {
  it('registering a DIFFERENT job under a taken name throws instead of replacing it', () => {
    const manager = new QueueManager(new SyncQueueDriver())
    manager.register(defineJob({ name: 'email.send', handle: () => {} }))
    expect(() => manager.register(defineJob({ name: 'email.send', handle: () => {} }))).toThrow(DuplicateJobError)
  })

  it('registering the SAME job twice stays a no-op', () => {
    const manager = new QueueManager(new SyncQueueDriver())
    const job = defineJob({ name: 'email.send', handle: () => {} })
    manager.register(job).register(job)
  })

  it('dispatching a different same-named definition throws instead of running the other handler', async () => {
    const manager = new QueueManager(new SyncQueueDriver())
    const ran: string[] = []
    manager.register(defineJob({ name: 'x', handle: () => void ran.push('first') }))
    const impostor = defineJob({ name: 'x', handle: () => void ran.push('second') })
    await expect(manager.dispatch(impostor, {})).rejects.toBeInstanceOf(DuplicateJobError)
    expect(ran).toEqual([])
  })

  it('two queuedOn listeners on one event: the second throws unless it has its own name', async () => {
    const manager = new QueueManager(new SyncQueueDriver())
    const bus = new EventBus()
    const OrderCreated = defineEvent('order.created', z.object({ id: z.string() }))
    const ran: string[] = []
    queuedOn(bus, manager, OrderCreated, ({ id }) => void ran.push(`mail:${id}`))
    expect(() => queuedOn(bus, manager, OrderCreated, ({ id }) => void ran.push(`crm:${id}`))).toThrow(
      DuplicateJobError,
    )
    queuedOn(bus, manager, OrderCreated, ({ id }) => void ran.push(`crm:${id}`), { name: 'order.created:crm' })

    await bus.emit(OrderCreated, { id: 'o-1' })
    expect(ran.sort()).toEqual(['crm:o-1', 'mail:o-1'])
  })
})

describe('FA-066: attempts bounds (sync driver)', () => {
  it('defineJob refuses a non-positive or fractional attempts', () => {
    for (const attempts of [0, -1, 1.5, Number.NaN]) {
      expect(() => defineJob({ name: 'bad', attempts, handle: () => {} })).toThrow(/positive integer/)
    }
  })

  it('the sync driver runs at least once — attempts 0 used to skip the handler and reject with undefined', async () => {
    const driver = new SyncQueueDriver()
    let calls = 0
    driver.setExecutor(async () => {
      calls++
    })
    await driver.add('q', 'j', {}, { attempts: 0 })
    expect(calls).toBe(1)
  })

  it('the sync driver caps inline retries at 50', async () => {
    const driver = new SyncQueueDriver()
    let calls = 0
    driver.setExecutor(async () => {
      calls++
      throw new Error('always')
    })
    await expect(driver.add('q', 'j', {}, { attempts: 1_000_000 })).rejects.toThrow('always')
    expect(calls).toBe(50)
  })
})

describe('FA-066: queue:retry / queue:jobs --limit', () => {
  const commands = async () => {
    let retriedWith: unknown = 'not-called'
    const driver: QueueDriver = {
      setExecutor() {},
      async add() {},
      startWorker() {},
      async close() {},
      async retryFailed(_queue, options) {
        retriedWith = options
        return 0
      },
      async list() {
        return []
      },
    }
    const app = await createApp({ plugins: [queuePlugin({ driver })] }).boot()
    const list = ensureMetadata(app.container).get<{ name: string; handle: (c: unknown) => Promise<void> }>('commands')
    const get = (name: string) => list.find((command) => command.name === name)!
    return { get, retried: () => retriedWith }
  }
  const io = { log() {}, table() {} }

  it.each(['0', '-5', 'abc', '2.5'])('queue:retry --limit %s is refused — it never reaches the driver', async (limit) => {
    const { get, retried } = await commands()
    await expect(get('queue:retry').handle({ io, flags: { limit } })).rejects.toThrow(/positive integer/)
    expect(retried()).toBe('not-called')
  })

  it('queue:jobs --limit 0 is refused too', async () => {
    const { get } = await commands()
    await expect(get('queue:jobs').handle({ io, flags: { limit: '0' } })).rejects.toThrow(/positive integer/)
  })

  it('a valid --limit still passes through', async () => {
    const { get, retried } = await commands()
    await get('queue:retry').handle({ io, flags: { limit: '10' } })
    expect(retried()).toEqual({ limit: 10 })
  })
})
