import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createApp, ctx, runWithContext } from '@machize/core'
import { defineEvent, EventBus } from '@machize/events'
import {
  defineJob,
  JobNotRegisteredError,
  JobValidationError,
  QUEUE,
  QueueManager,
  queuedOn,
  queuePlugin,
  SyncQueueDriver,
} from '../src/index.js'

const setup = () => {
  const driver = new SyncQueueDriver()
  const manager = new QueueManager(driver)
  return { driver, manager }
}

describe('QueueManager (driver sync)', () => {
  it('dispatches and executes a job with a typed, validated payload', async () => {
    const { manager } = setup()
    const seen: string[] = []
    const SendWelcome = defineJob({
      name: 'email.welcome',
      schema: z.object({ userId: z.string() }),
      handle: ({ userId }) => void seen.push(userId),
    })
    manager.register(SendWelcome)

    await SendWelcome.dispatch({ userId: 'u-1' })
    expect(seen).toEqual(['u-1'])
  })

  it('rejects an invalid payload at dispatch, before enqueuing', async () => {
    const { driver, manager } = setup()
    const job = defineJob({
      name: 'strict',
      schema: z.object({ n: z.number() }),
      handle: () => {},
    })
    manager.register(job)

    await expect(job.dispatch({ n: 'x' as unknown as number })).rejects.toBeInstanceOf(
      JobValidationError,
    )
    expect(driver.executed).toHaveLength(0)
  })

  it('dispatch without registration throws an error guiding the dev', async () => {
    const solto = defineJob({ name: 'solto', handle: () => {} })
    await expect(solto.dispatch({})).rejects.toBeInstanceOf(JobNotRegisteredError)
  })

  it('propagates the context (requestId/tenant) from dispatch to the handler', async () => {
    const { manager } = setup()
    const observed: Record<string, unknown>[] = []
    const job = defineJob({
      name: 'ctx.probe',
      handle: () => {
        const c = ctx()
        observed.push({ requestId: c.requestId, tenant: c['tenant'] })
      },
    })
    manager.register(job)

    await runWithContext({ requestId: 'req-7', tenant: { id: 'acme', name: 'Acme' } }, () =>
      job.dispatch({}),
    )
    expect(observed).toEqual([{ requestId: 'req-7', tenant: { id: 'acme' } }])
  })

  it('honors attempts: re-executes until it succeeds', async () => {
    const { driver, manager } = setup()
    let calls = 0
    const flaky = defineJob({
      name: 'flaky',
      attempts: 3,
      handle: () => {
        calls++
        if (calls < 3) throw new Error('transiente')
      },
    })
    manager.register(flaky)

    await flaky.dispatch({})
    expect(calls).toBe(3)
    expect(driver.executed[0]).toMatchObject({ jobName: 'flaky', attempts: 3 })
  })

  it('exhausts attempts and propagates the last error', async () => {
    const { manager } = setup()
    const doomed = defineJob({
      name: 'doomed',
      attempts: 2,
      handle: () => {
        throw new Error('permanente')
      },
    })
    manager.register(doomed)
    await expect(doomed.dispatch({})).rejects.toThrowError('permanente')
  })

  it('queuedOn: event listener becomes a job with context and validation', async () => {
    const { driver, manager } = setup()
    const bus = new EventBus()
    const OrderCreated = defineEvent('order.created', z.object({ orderId: z.string() }))
    const seen: string[] = []

    queuedOn(bus, manager, OrderCreated, ({ orderId }) => {
      seen.push(`${orderId}:${ctx().requestId as string}`)
    })

    await runWithContext({ requestId: 'req-9' }, () => bus.emit(OrderCreated, { orderId: 'o-1' }))
    expect(seen).toEqual(['o-1:req-9'])
    expect(driver.executed[0]?.jobName).toBe('listener:order.created')
  })

  it('queuePlugin registers the manager, binds jobs and closes on shutdown', async () => {
    const seen: string[] = []
    const job = defineJob({
      name: 'via.plugin',
      schema: z.object({ v: z.string() }),
      handle: ({ v }) => void seen.push(v),
    })
    const app = await createApp({
      plugins: [queuePlugin({ jobs: [job as never] })],
    }).boot()

    await job.dispatch({ v: 'ok' })
    expect(seen).toEqual(['ok'])
    expect(app.container.get(QUEUE)).toBeInstanceOf(QueueManager)
    await app.shutdown()
  })
})
