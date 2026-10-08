import { HookBus } from '@basaltkit/core'
import { describe, expect, it, vi } from 'vitest'
import { connect, harness } from './helpers.js'

describe('drive:disconnecting', () => {
  it('fires before revoke and delete, while the row can still be found', async () => {
    const hooks = new HookBus()
    const h = harness({ drives: { hooks } })
    const view = await connect(h, { tenantId: 'acme' })
    const order: string[] = []
    hooks.on('drive:disconnecting', async (payload) => {
      expect(payload).toEqual({ tenantId: 'acme', connectionId: view.id, provider: 'fake' })
      // The row is still there for a cascade to read.
      expect(await h.store.find('acme', view.id)).not.toBeNull()
      expect(h.fake.calls['revoke']).toBeUndefined()
      order.push('disconnecting')
    })
    hooks.on('drive:disconnected', async () => {
      expect(await h.store.find('acme', view.id)).toBeNull()
      order.push('disconnected')
    })
    await h.drives.disconnect(view.id, { tenantId: 'acme' })
    expect(order).toEqual(['disconnecting', 'disconnected'])
    expect(h.fake.calls['revoke']).toBe(1)
  })

  it('a throwing handler vetoes: no revoke, row kept, error propagated', async () => {
    const hooks = new HookBus()
    const h = harness({ drives: { hooks } })
    const view = await connect(h, { tenantId: 'acme' })
    const disconnected = vi.fn()
    hooks.on('drive:disconnecting', () => {
      throw new Error('imports still running')
    })
    hooks.on('drive:disconnected', disconnected)
    await expect(h.drives.disconnect(view.id, { tenantId: 'acme' })).rejects.toThrow('imports still running')
    expect(h.fake.calls['revoke']).toBeUndefined()
    expect(await h.store.find('acme', view.id)).not.toBeNull()
    expect(disconnected).not.toHaveBeenCalled()
  })

  it('force: true proceeds despite a veto and reports the error to onHookError', async () => {
    const hooks = new HookBus()
    const onHookError = vi.fn()
    const h = harness({ drives: { hooks, onHookError } })
    const view = await connect(h, { tenantId: 'acme' })
    const boom = new Error('buggy cascade')
    hooks.on('drive:disconnecting', () => {
      throw boom
    })
    await h.drives.disconnect(view.id, { tenantId: 'acme', force: true })
    expect(h.fake.calls['revoke']).toBe(1)
    expect(await h.store.find('acme', view.id)).toBeNull()
    expect(onHookError).toHaveBeenCalledWith(boom, {
      hook: 'drive:disconnecting',
      tenantId: 'acme',
      connectionId: view.id,
    })
  })

  it('force: true without onHookError emits a process warning rather than swallowing', async () => {
    const hooks = new HookBus()
    const h = harness({ drives: { hooks } })
    const view = await connect(h, { tenantId: 'acme' })
    hooks.on('drive:disconnecting', () => {
      throw new Error('buggy cascade')
    })
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    try {
      await h.drives.disconnect(view.id, { tenantId: 'acme', force: true })
      expect(warn).toHaveBeenCalledOnce()
      expect(String(warn.mock.calls[0]?.[0])).toContain('drive:disconnecting')
    } finally {
      warn.mockRestore()
    }
    expect(await h.store.find('acme', view.id)).toBeNull()
  })
})
