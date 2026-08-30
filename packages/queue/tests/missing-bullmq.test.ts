import { describe, expect, it, vi } from 'vitest'

/**
 * `bullmq` is an optional peer: `queuePlugin({ connection })` on an app that
 * never installed it must fail with instructions, not with a raw
 * `ERR_MODULE_NOT_FOUND` thrown from inside `drivers/bullmq.js`. Simulated by
 * making the module resolution itself blow up.
 */
vi.mock('bullmq', () => {
  throw new Error("Cannot find package 'bullmq' imported from drivers/bullmq.js")
})

const { createApp } = await import('@basaltkit/core')
const { queuePlugin, MissingQueueDriverPackageError } = await import('../src/index.js')

describe('a missing `bullmq` peer fails with actionable guidance', () => {
  it('boot() reports how to fix it, and keeps the original cause', async () => {
    const boot = createApp({
      plugins: [queuePlugin({ connection: 'redis://localhost:6379' })],
    }).boot()

    await expect(boot).rejects.toThrow(MissingQueueDriverPackageError)
    const error = await boot.then(
      () => {
        throw new Error('boot() should have rejected')
      },
      (caught: unknown) => caught as InstanceType<typeof MissingQueueDriverPackageError>,
    )
    expect(error.code).toBe('QUEUE_MISSING_DRIVER_PACKAGE')
    expect(error.message).toContain('optional peer dependency')
    expect(error.message).toContain('pnpm add bullmq')
    // The escape hatches, so the message answers "what do I do instead?".
    expect(error.message).toContain('@basaltkit/queue-sqs')
    expect(error.message).toContain('SyncQueueDriver')
    // The underlying resolution failure is preserved for debugging, not
    // swallowed. (Under Vitest the cause is the runner's module-mock wrapper
    // around it; in a real app it is the ERR_MODULE_NOT_FOUND itself.)
    expect(error.cause).toBeInstanceOf(Error)
  })

  it('the sync driver still boots fine without bullmq installed', async () => {
    const { QUEUE } = await import('../src/index.js')
    const app = await createApp({ plugins: [queuePlugin({})] }).boot()
    expect(app.container.get(QUEUE)).toBeDefined()
    await app.shutdown()
  })
})
