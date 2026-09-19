import { describe, expect, it, vi } from 'vitest'
import { runWithContext } from '@basaltkit/core'
import {
  MemoryWebhookStore,
  MIN_WEBHOOK_SECRET_LENGTH,
  signPayload,
  verifySignature,
  WebhookDeliverer,
  WebhookManager,
} from '../src/index.js'

const publicDns = { lookup: async () => [{ address: '93.184.216.34' }] }
const okResponse = () => ({ ok: true, status: 200 }) as unknown as Response
const SHARED = 'whsec_plugin_wide_0123456789'
const asTenant = <T>(id: string, fn: () => T): T => runWithContext({ tenant: { id } } as never, fn)

function recordingDeliverer(options: ConstructorParameters<typeof WebhookDeliverer>[0] = {}) {
  const fetchImpl = vi.fn(async (_url: string | URL, _init?: RequestInit) => okResponse())
  const deliverer = new WebhookDeliverer({ fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {}, ssrf: publicDns, ...options })
  const headers = (i = 0) => fetchImpl.mock.calls[i]![1]!.headers as Record<string, string>
  const body = (i = 0) => JSON.parse(String(fetchImpl.mock.calls[i]![1]!.body)) as Record<string, unknown>
  return { deliverer, fetchImpl, headers, body }
}

/**
 * SECURITY INVARIANTS for webhook signing:
 * - every tenant endpoint is signed with its own secret, never a secret shared
 *   with other tenants (a tenant must not be able to forge another's webhooks);
 * - a delivery is never sent unsigned by default;
 * - a receiver's verifySignature never accepts an empty/unset or trivially short secret;
 * - each delivery carries a unique id bound into the signed content.
 */
describe('webhook signing hardening', () => {
  it('verifySignature rejects an empty or too-short secret even for a matching HMAC', () => {
    const body = '{"a":1}'
    expect(verifySignature(signPayload(body, '', 1000), body, '', 300, 1000)).toBe(false)
    expect(verifySignature(signPayload(body, 'short', 1000), body, 'short', 300, 1000)).toBe(false)
    const strong = 'x'.repeat(MIN_WEBHOOK_SECRET_LENGTH)
    expect(verifySignature(signPayload(body, strong, 1000), body, strong, 300, 1000)).toBe(true)
  })

  it('register() generates a per-endpoint secret for a tenant endpoint and returns it once', async () => {
    const store = new MemoryWebhookStore()
    const { deliverer } = recordingDeliverer({ secret: SHARED })
    const manager = new WebhookManager(store, deliverer)
    const acme = await asTenant('acme', () => manager.register({ url: 'https://acme.example/h', events: ['*'] }))
    const globex = await asTenant('globex', () => manager.register({ url: 'https://globex.example/h', events: ['*'] }))
    expect(acme.secret).toMatch(/^whsec_/)
    expect(acme.secret!.length).toBeGreaterThanOrEqual(MIN_WEBHOOK_SECRET_LENGTH)
    expect(acme.secret).not.toBe(globex.secret)
    expect(acme.secret).not.toBe(SHARED)
  })

  it('a tenant endpoint is never signed with the plugin-wide shared secret', async () => {
    const { deliverer, fetchImpl } = recordingDeliverer({ secret: SHARED })
    const result = await deliverer.deliver({ id: 'g', url: 'https://globex.example/h', events: ['*'], tenantId: 'globex' }, 'invoice.paid', {})
    expect(result.ok).toBe(false)
    expect(result.attempts).toBe(0)
    expect(result.error).toMatch(/shared secret/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('allowSharedSecret is the named opt-out for the shared-secret refusal', async () => {
    const { deliverer, fetchImpl } = recordingDeliverer({ secret: SHARED, allowSharedSecret: true })
    const result = await deliverer.deliver({ id: 'g', url: 'https://globex.example/h', events: ['*'], tenantId: 'globex' }, 'e', {})
    expect(result.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('refuses to send an unsigned delivery by default', async () => {
    const { deliverer, fetchImpl } = recordingDeliverer()
    const result = await deliverer.deliver({ id: 'x', url: 'https://hook.example/h', events: ['*'] }, 'e', {})
    expect(result.ok).toBe(false)
    expect(result.attempts).toBe(0)
    expect(result.error).toMatch(/unsigned/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('allowUnsigned is the named opt-out for unsigned deliveries', async () => {
    const { deliverer, headers } = recordingDeliverer({ allowUnsigned: true })
    const result = await deliverer.deliver({ id: 'x', url: 'https://hook.example/h', events: ['*'] }, 'e', {})
    expect(result.ok).toBe(true)
    expect(headers()['x-basalt-signature']).toBeUndefined()
  })

  it('refuses a plugin-wide secret shorter than the minimum at construction', () => {
    expect(() => new WebhookDeliverer({ secret: 'short' })).toThrow(/at least/)
  })

  it('refuses to sign with a too-short per-endpoint secret', async () => {
    const { deliverer, fetchImpl } = recordingDeliverer({ secret: SHARED })
    const result = await deliverer.deliver({ id: 'x', url: 'https://hook.example/h', events: ['*'], secret: 's' }, 'e', {})
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/too short/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('binds a unique delivery id and the endpoint id into the signed body and a header', async () => {
    const endpoint = { id: 'ep_1', url: 'https://hook.example/h', events: ['*'], secret: SHARED }
    const { deliverer, headers, body } = recordingDeliverer({ now: () => 1000 })
    await deliverer.deliver(endpoint, 'invoice.paid', { n: 1 })
    await deliverer.deliver(endpoint, 'invoice.paid', { n: 1 })
    expect(body(0).id).toBeTypeOf('string')
    expect(body(0).id).toBe(headers(0)['x-basalt-delivery'])
    expect(body(0).endpointId).toBe('ep_1')
    expect(body(0).id).not.toBe(body(1).id)
    // The id is covered by the signature (it is part of the signed body).
    const raw = JSON.stringify(body(0))
    expect(verifySignature(headers(0)['x-basalt-signature']!, raw, SHARED, 300, 1000)).toBe(true)
    const tampered = JSON.stringify({ ...body(0), id: body(1).id })
    expect(verifySignature(headers(0)['x-basalt-signature']!, tampered, SHARED, 300, 1000)).toBe(false)
  })

  it('keeps the same delivery id across retries of one delivery (receiver idempotency key)', async () => {
    let n = 0
    const fetchImpl = vi.fn(async (_url: string | URL, _init?: RequestInit) => ({ ok: n++ > 0, status: n > 1 ? 200 : 503 }) as unknown as Response)
    const deliverer = new WebhookDeliverer({ fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {}, ssrf: publicDns, secret: SHARED })
    await deliverer.deliver({ id: 'x', url: 'https://hook.example/h', events: ['*'] }, 'e', {})
    const ids = fetchImpl.mock.calls.map((c) => (c[1]!.headers as Record<string, string>)['x-basalt-delivery'])
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
  })
})
