import { Container, HookBus, createApp } from '@basaltkit/core'
import { describe, expect, it } from 'vitest'
import { idempotencyHeaderOf, idempotencyPlugin } from '../src/index.js'

/**
 * `idempotencyHeaderOf` is the public way to learn the configured idempotency
 * header. Other packages (`@basaltkit/mcp`) use it instead of reading http's
 * internal metadata bucket.
 */
describe('idempotencyHeaderOf', () => {
  it("returns 'idempotency-key' when idempotencyPlugin is registered with the default header", async () => {
    const app = await createApp({ plugins: [idempotencyPlugin()] }).boot()
    try {
      expect(idempotencyHeaderOf(app.container)).toBe('idempotency-key')
    } finally {
      await app.shutdown()
    }
  })

  it('returns the custom header, lower-cased', async () => {
    const app = await createApp({ plugins: [idempotencyPlugin({ header: 'X-Request-Key' })] }).boot()
    try {
      expect(idempotencyHeaderOf(app.container)).toBe('x-request-key')
    } finally {
      await app.shutdown()
    }
  })

  it('returns undefined when idempotencyPlugin is not registered', async () => {
    expect(idempotencyHeaderOf(new Container())).toBeUndefined()
    const app = await createApp({ plugins: [] }).boot()
    try {
      expect(idempotencyHeaderOf(app.container)).toBeUndefined()
    } finally {
      await app.shutdown()
    }
  })

  it('caches nothing: a call before registration does not hide a stage registered later', async () => {
    const container = new Container()
    expect(idempotencyHeaderOf(container)).toBeUndefined()
    await idempotencyPlugin({ header: 'X-Late' }).register?.({
      container,
      hooks: new HookBus(),
      config: {},
    } as never)
    expect(idempotencyHeaderOf(container)).toBe('x-late')
  })
})
