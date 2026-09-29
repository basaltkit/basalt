/**
 * Regression tests for the framework audit "Melhorias" item 6 (webhooks):
 * port policy, DNS resolution inside the per-attempt deadline, the dispatch
 * fan-out cap, and sender-side secret rotation. Each case fails on the code
 * before the fix.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_BLOCKED_PORTS,
  isPortAllowed,
  MemoryWebhookStore,
  resolveAndValidate,
  signPayload,
  verifySignature,
  WebhookDeliverer,
  WebhookEndpointInvalidError,
  WebhookEndpointNotFoundError,
  WebhookManager,
  WebhookUrlBlockedError,
  type WebhookFanOutExceeded,
} from '../src/index.js'
import { runWithContext } from '@basaltkit/core'

const SECRET = 's'.repeat(16)
const publicLookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])
const ok = () => vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 200 }))
const noSleep = async () => {}

describe('port policy', () => {
  it.each([25, 22, 6379, 11211, 5432, 3306, 27017, 2375, 10250])('refuses port %i on a public IP literal', async (port) => {
    await expect(resolveAndValidate(`http://93.184.216.34:${port}/`)).rejects.toThrow(`port ${port} is not allowed`)
  })

  it('refuses the port before resolving the hostname (no DNS lookup)', async () => {
    const lookup = vi.fn(async () => [{ address: '93.184.216.34' }])
    await expect(resolveAndValidate('http://redis.example.com:6379/', { lookup })).rejects.toBeInstanceOf(WebhookUrlBlockedError)
    expect(lookup).not.toHaveBeenCalled()
  })

  it.each([80, 443, 3000, 8080, 8443, 9000, 49152])('allows port %i by default', async (port) => {
    await expect(resolveAndValidate(`http://93.184.216.34:${port}/`)).resolves.toMatchObject({ pinned: { address: '93.184.216.34' } })
  })

  it('the default rule: 80/443, >=1024 minus the denylist', () => {
    expect(isPortAllowed(443)).toBe(true)
    expect(isPortAllowed(1023)).toBe(false)
    expect(isPortAllowed(1024)).toBe(true)
    expect(isPortAllowed(0)).toBe(false)
    expect(isPortAllowed(70_000)).toBe(false)
    for (const port of DEFAULT_BLOCKED_PORTS) expect(isPortAllowed(port)).toBe(false)
    expect(Object.isFrozen(DEFAULT_BLOCKED_PORTS)).toBe(true)
  })

  it('allowedPorts replaces the default; "any" disables it', async () => {
    await expect(resolveAndValidate('https://93.184.216.34:8443/', { allowedPorts: [443] })).rejects.toThrow('port 8443')
    await expect(resolveAndValidate('https://93.184.216.34/', { allowedPorts: [443] })).resolves.toBeDefined()
    await expect(resolveAndValidate('http://93.184.216.34:6379/', { allowedPorts: [6379] })).resolves.toBeDefined()
    await expect(resolveAndValidate('http://93.184.216.34:25/', { allowedPorts: 'any' })).resolves.toBeDefined()
  })

  it('still applies with allowPrivateHosts', async () => {
    await expect(resolveAndValidate('http://10.0.0.5:6379/', { allowPrivateHosts: true })).rejects.toThrow('port 6379')
    await expect(resolveAndValidate('http://10.0.0.5:8080/', { allowPrivateHosts: true })).resolves.toBeDefined()
  })

  it('deliver() refuses a blocked port permanently, without sending', async () => {
    const fx = ok()
    const d = new WebhookDeliverer({ secret: SECRET, fetchImpl: fx as never, fetchImplPinsAddress: true, ssrf: { lookup: publicLookup } })
    const r = await d.deliver({ id: 'e', url: 'http://hooks.example.com:11211/', events: ['*'] }, 'a.b', {})
    expect(r).toMatchObject({ ok: false, attempts: 0, retryable: false })
    expect(r.error).toContain('port 11211 is not allowed')
    expect(fx).not.toHaveBeenCalled()
  })

  it('register() refuses a blocked port, honouring the deliverer policy', async () => {
    const strict = new WebhookManager(new MemoryWebhookStore(), new WebhookDeliverer({ secret: SECRET }))
    await expect(strict.register({ url: 'http://hooks.example.com:6379/', events: ['*'] })).rejects.toBeInstanceOf(WebhookEndpointInvalidError)
    await expect(strict.register({ url: 'smtp://x', events: ['*'] })).rejects.toBeInstanceOf(WebhookEndpointInvalidError)
    await expect(strict.register({ url: 'https://hooks.example.com:8443/', events: ['*'] })).resolves.toBeDefined()

    const custom = new WebhookManager(new MemoryWebhookStore(), new WebhookDeliverer({ secret: SECRET, ssrf: { allowedPorts: [443] } }))
    await expect(custom.register({ url: 'https://hooks.example.com:8443/', events: ['*'] })).rejects.toThrow('port 8443')

    const off = new WebhookManager(new MemoryWebhookStore(), new WebhookDeliverer({ secret: SECRET, ssrf: false }))
    await expect(off.register({ url: 'http://hooks.example.com:6379/', events: ['*'] })).resolves.toBeDefined()
  })

  it('a malformed allowedPorts fails at construction', () => {
    expect(() => new WebhookDeliverer({ ssrf: { allowedPorts: ['443'] as never } })).toThrow(TypeError)
    expect(() => new WebhookDeliverer({ ssrf: { allowedPorts: [] } })).toThrow(TypeError)
    expect(() => new WebhookDeliverer({ ssrf: { allowedPorts: [0] } })).toThrow(TypeError)
  })
})

describe('DNS resolution inside the per-attempt deadline', () => {
  it('a resolver that never answers fails each attempt at timeoutMs (transient, retried)', async () => {
    const lookup = vi.fn(() => new Promise<{ address: string }[]>(() => {}))
    const fx = ok()
    const d = new WebhookDeliverer({
      secret: SECRET,
      timeoutMs: 30,
      maxRetries: 2,
      sleep: noSleep,
      fetchImpl: fx as never,
      fetchImplPinsAddress: true,
      ssrf: { lookup },
    })
    const started = Date.now()
    const r = await d.deliver({ id: 'e', url: 'https://slow-dns.example/', events: ['*'] }, 'a.b', {})
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(r).toMatchObject({ ok: false, attempts: 3, retryable: true, error: 'host resolution timed out' })
    expect(lookup).toHaveBeenCalledTimes(3)
    expect(fx).not.toHaveBeenCalled()
  })

  it('re-resolves on the next attempt after a DNS timeout and then delivers', async () => {
    let calls = 0
    const lookup = vi.fn(() => (++calls === 1 ? new Promise<{ address: string }[]>(() => {}) : Promise.resolve([{ address: '93.184.216.34' }])))
    const fx = ok()
    const d = new WebhookDeliverer({ secret: SECRET, timeoutMs: 30, sleep: noSleep, fetchImpl: fx as never, fetchImplPinsAddress: true, ssrf: { lookup } })
    const r = await d.deliver({ id: 'e', url: 'https://flaky-dns.example/', events: ['*'] }, 'a.b', {})
    expect(r).toMatchObject({ ok: true, attempts: 2 })
    expect(fx).toHaveBeenCalledTimes(1)
  })

  it('the deadline covers DNS + request together', async () => {
    const lookup = vi.fn(() => new Promise<{ address: string }[]>((resolve) => setTimeout(() => resolve([{ address: '93.184.216.34' }]), 20)))
    let aborted = false
    const fx = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            aborted = true
            reject(new Error('aborted'))
          })
        }),
    )
    const d = new WebhookDeliverer({ secret: SECRET, timeoutMs: 40, maxRetries: 0, fetchImpl: fx as never, fetchImplPinsAddress: true, ssrf: { lookup } })
    const r = await d.deliver({ id: 'e', url: 'https://hook.example/', events: ['*'] }, 'a.b', {})
    expect(r).toMatchObject({ ok: false, attempts: 1, retryable: true })
    expect(aborted).toBe(true)
  })
})

describe('dispatch fan-out cap and concurrency', () => {
  const deliverer = (fx: ReturnType<typeof ok>) =>
    new WebhookDeliverer({ secret: SECRET, fetchImpl: fx as never, fetchImplPinsAddress: true, ssrf: { lookup: publicLookup } })

  it('refuses a scope over the cap whole — no delivery — and reports it', async () => {
    const fx = ok()
    const seen: WebhookFanOutExceeded[] = []
    const mgr = new WebhookManager(new MemoryWebhookStore(), deliverer(fx), { maxEndpointsPerDispatch: 2, onFanOutExceeded: (i) => seen.push(i) })
    for (let i = 0; i < 3; i++) await mgr.register({ id: `a${i}`, url: `https://a${i}.example/`, events: ['*'], tenantId: 'acme' })
    await mgr.register({ id: 'b0', url: 'https://b0.example/', events: ['*'], tenantId: 'globex' })
    await mgr.register({ id: 'g0', url: 'https://g0.example/', events: ['*'] })

    const results = await mgr.dispatch('invoice.paid', {}, 'acme')
    expect(fx).toHaveBeenCalledTimes(1) // only the tenant-agnostic endpoint
    expect(results.filter((r) => r.endpointId.startsWith('a'))).toHaveLength(3)
    for (const r of results.filter((r) => r.endpointId.startsWith('a'))) {
      expect(r).toMatchObject({ ok: false, attempts: 0, retryable: false })
      expect(r.error).toContain('fan-out cap exceeded')
    }
    expect(results.find((r) => r.endpointId === 'g0')?.ok).toBe(true)
    expect(seen).toEqual([{ event: 'invoice.paid', tenantId: 'acme', endpoints: 3, limit: 2 }])

    // System fan-out: the cap is per tenant, other tenants are unaffected.
    fx.mockClear()
    const all = await mgr.dispatch('invoice.paid', {}, { allTenants: true })
    expect(all.find((r) => r.endpointId === 'b0')?.ok).toBe(true)
    expect(fx).toHaveBeenCalledTimes(2)
  })

  it('has a finite default cap and can be disabled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fx = ok()
    const mgr = new WebhookManager(new MemoryWebhookStore(), deliverer(fx))
    for (let i = 0; i < 101; i++) await mgr.register({ id: `e${i}`, url: `https://e${i}.example/`, events: ['*'], tenantId: 't' })
    const results = await mgr.dispatch('x', {}, 't')
    expect(results.every((r) => !r.ok)).toBe(true)
    expect(fx).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()

    const store = new MemoryWebhookStore()
    const unbounded = new WebhookManager(store, deliverer(fx), { maxEndpointsPerDispatch: false })
    for (let i = 0; i < 101; i++) await unbounded.register({ id: `e${i}`, url: `https://e${i}.example/`, events: ['*'], tenantId: 't' })
    expect((await unbounded.dispatch('x', {}, 't')).every((r) => r.ok)).toBe(true)
  })

  it('bounds the deliveries in flight per dispatch, keeping result order', async () => {
    let inFlight = 0
    let peak = 0
    const d = { deliver: async (endpoint: { id: string }) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return { endpointId: endpoint.id, ok: true, attempts: 1 }
    } } as unknown as WebhookDeliverer
    const store = new MemoryWebhookStore()
    for (let i = 0; i < 10; i++) await store.add({ id: `e${i}`, url: `https://e${i}.example/`, events: ['*'] })
    const mgr = new WebhookManager(store, d, { dispatchConcurrency: 3 })
    const results = await mgr.dispatch('x', {})
    expect(peak).toBe(3)
    expect(results.map((r) => r.endpointId)).toEqual(Array.from({ length: 10 }, (_, i) => `e${i}`))
  })

  it('validates its options', () => {
    const d = new WebhookDeliverer({ secret: SECRET })
    expect(() => new WebhookManager(new MemoryWebhookStore(), d, { maxEndpointsPerDispatch: 0 })).toThrow(TypeError)
    expect(() => new WebhookManager(new MemoryWebhookStore(), d, { dispatchConcurrency: 1.5 })).toThrow(TypeError)
  })
})

describe('sender-side secret rotation', () => {
  const setup = (clock: { now: number }) => {
    const fx = ok()
    const deliverer = new WebhookDeliverer({
      fetchImpl: fx as never,
      fetchImplPinsAddress: true,
      ssrf: { lookup: publicLookup },
      now: () => Math.floor(clock.now / 1000),
    })
    const store = new MemoryWebhookStore()
    const mgr = new WebhookManager(store, deliverer, { now: () => clock.now })
    const lastHeader = () => (fx.mock.calls.at(-1)![1].headers as Record<string, string>)['x-basalt-signature']!
    const lastBody = () => fx.mock.calls.at(-1)![1].body as string
    return { fx, mgr, store, lastHeader, lastBody }
  }

  it('signs with both secrets during the grace window, then only the new one', async () => {
    const clock = { now: Date.UTC(2026, 8, 29) }
    const { mgr, lastHeader, lastBody } = setup(clock)
    const endpoint = await mgr.register({ url: 'https://hook.example/', events: ['*'], tenantId: 'acme' })
    const old = endpoint.secret!

    const rotated = await mgr.rotateSecret(endpoint.id, { tenantId: 'acme', graceSeconds: 3600 })
    expect(rotated.secret).not.toBe(old)
    expect(rotated.previousSecret).toBeUndefined() // not echoed back
    expect(rotated.previousSecretExpiresAt).toEqual(new Date(clock.now + 3_600_000))

    await mgr.dispatch('a.b', {}, 'acme')
    const nowS = Math.floor(clock.now / 1000)
    expect(lastHeader().match(/v1=/g)).toHaveLength(2)
    expect(verifySignature(lastHeader(), lastBody(), old, 300, nowS)).toBe(true)
    expect(verifySignature(lastHeader(), lastBody(), rotated.secret!, 300, nowS)).toBe(true)

    clock.now += 3_600_001
    await mgr.dispatch('a.b', {}, 'acme')
    const laterS = Math.floor(clock.now / 1000)
    expect(lastHeader().match(/v1=/g)).toHaveLength(1)
    expect(verifySignature(lastHeader(), lastBody(), old, 300, laterS)).toBe(false)
    expect(verifySignature(lastHeader(), lastBody(), rotated.secret!, 300, laterS)).toBe(true)
  })

  it('never lists either secret', async () => {
    const { mgr } = setup({ now: Date.now() })
    const e = await mgr.register({ url: 'https://hook.example/', events: ['*'], tenantId: 'acme' })
    await mgr.rotateSecret(e.id, { tenantId: 'acme' })
    const [view] = await mgr.list('acme')
    expect(view).not.toHaveProperty('secret')
    expect(view).not.toHaveProperty('previousSecret')
    expect(view).toMatchObject({ hasSecret: true })
  })

  it('graceSeconds: 0 cuts over immediately; a caller-chosen secret is used', async () => {
    const clock = { now: Date.now() }
    const { mgr, lastHeader } = setup(clock)
    const e = await mgr.register({ url: 'https://hook.example/', events: ['*'], tenantId: 'acme' })
    const r = await mgr.rotateSecret(e.id, { tenantId: 'acme', secret: 'n'.repeat(20), graceSeconds: 0 })
    expect(r.secret).toBe('n'.repeat(20))
    await mgr.dispatch('a.b', {}, 'acme')
    expect(lastHeader().match(/v1=/g)).toHaveLength(1)
  })

  it('re-registering an endpoint mid-rotation ends the rotation (revocation)', async () => {
    const clock = { now: Date.now() }
    const { mgr, store, lastHeader } = setup(clock)
    const e = await mgr.register({ url: 'https://hook.example/', events: ['*'], tenantId: 'acme' })
    await mgr.rotateSecret(e.id, { tenantId: 'acme' })
    await mgr.register({ id: e.id, url: 'https://hook.example/', events: ['*'], tenantId: 'acme', secret: 'r'.repeat(20) })
    expect((await store.list('acme'))[0]!.previousSecret).toBeUndefined()
    await mgr.dispatch('a.b', {}, 'acme')
    expect(lastHeader().match(/v1=/g)).toHaveLength(1)
  })

  it('is tenant-scoped and refuses what it cannot rotate', async () => {
    const { mgr } = setup({ now: Date.now() })
    const e = await mgr.register({ url: 'https://hook.example/', events: ['*'], tenantId: 'acme' })
    await expect(runWithContext({ tenant: { id: 'globex' } } as never, () => mgr.rotateSecret(e.id, { tenantId: 'acme' }))).rejects.toBeInstanceOf(
      WebhookEndpointNotFoundError,
    )
    await expect(mgr.rotateSecret('nope', { tenantId: 'acme' })).rejects.toBeInstanceOf(WebhookEndpointNotFoundError)
    await expect(mgr.rotateSecret(e.id, { tenantId: 'acme', graceSeconds: -1 })).rejects.toBeInstanceOf(WebhookEndpointInvalidError)
    await expect(mgr.rotateSecret(e.id, { tenantId: 'acme', graceSeconds: 31 * 86_400 })).rejects.toBeInstanceOf(WebhookEndpointInvalidError)
    await expect(mgr.rotateSecret(e.id, { tenantId: 'acme', secret: 'short' })).rejects.toBeInstanceOf(WebhookEndpointInvalidError)

    const shared = new WebhookManager(new MemoryWebhookStore(), new WebhookDeliverer({ secret: SECRET }))
    const g = await shared.register({ url: 'https://hook.example/', events: ['*'] })
    expect(g.secret).toBeUndefined()
    await expect(shared.rotateSecret(g.id)).rejects.toThrow('default secret')
  })

  it('ignores a previous secret with no (or a past) expiry', async () => {
    const fx = ok()
    const d = new WebhookDeliverer({ fetchImpl: fx as never, ssrf: false })
    await d.deliver({ id: 'e', url: 'https://h.example/', events: ['*'], secret: SECRET, previousSecret: 'p'.repeat(16) }, 'a', {})
    expect((fx.mock.calls[0]![1].headers as Record<string, string>)['x-basalt-signature']!.match(/v1=/g)).toHaveLength(1)
  })

  it('signPayload accepts several secrets (current first)', () => {
    const header = signPayload('{}', ['a'.repeat(16), 'b'.repeat(16)], 100)
    expect(header).toMatch(/^t=100,v1=[0-9a-f]{64},v1=[0-9a-f]{64}$/)
    expect(verifySignature(header, '{}', 'b'.repeat(16), 300, 100)).toBe(true)
    expect(signPayload('{}', 'a'.repeat(16), 100)).toBe(header.split(',').slice(0, 2).join(','))
    expect(() => signPayload('{}', [], 100)).toThrow(TypeError)
  })
})
