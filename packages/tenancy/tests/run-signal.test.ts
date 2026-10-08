import { describe, expect, it } from 'vitest'
import { createApp, ensureMetadata, runWithContext, tryCtx } from '@basaltkit/core'
import {
  InvalidTenantIdError,
  MemoryTenantSource,
  TenantNotFoundError,
  tenancyPlugin,
  type TenantRunner,
} from '../src/index.js'

// 'tenancy:run' is the signal background code in other packages (the webhook
// manager's off-request endpoint lookup, a queue worker) reads to enter a
// tenant the official way without importing TENANCY.

const boot = async () => {
  const app = await createApp({
    plugins: [
      tenancyPlugin({
        source: new MemoryTenantSource().add({ id: 'acme', name: 'Acme' }),
        resolvers: [],
      }),
    ],
  }).boot()
  const events: string[] = []
  app.hooks.on('tenancy:switched', ({ tenant, via }) => void events.push(`switched ${tenant.id} ${via}`))
  app.hooks.on('tenancy:exited', ({ tenant }) => void events.push(`exited ${tenant.id}`))
  const run = ensureMetadata(app.container).get<TenantRunner>('tenancy:run')[0]!
  return { app, events, run }
}

describe("tenancyPlugin publishes the 'tenancy:run' signal", () => {
  it('registers exactly one runner', async () => {
    const { app, run } = await boot()
    expect(ensureMetadata(app.container).get('tenancy:run')).toHaveLength(1)
    expect(typeof run).toBe('function')
    await app.shutdown()
  })

  it('enters the tenant and pairs switched (via run) with exited', async () => {
    const { app, events, run } = await boot()
    const seen = await runWithContext({}, () => run('acme', () => tryCtx()?.tenant?.id))
    expect(seen).toBe('acme')
    expect(events).toEqual(['switched acme run', 'exited acme'])
    await app.shutdown()
  })

  it('refuses an unknown tenant and a malformed id before running fn', async () => {
    const { app, events, run } = await boot()
    let ran = false
    await expect(run('ghost', () => (ran = true))).rejects.toBeInstanceOf(TenantNotFoundError)
    await expect(run('../x', () => (ran = true))).rejects.toBeInstanceOf(InvalidTenantIdError)
    expect(ran).toBe(false)
    expect(events).toEqual([])
    await app.shutdown()
  })
})
