/**
 * Regression tests for the framework audit findings FA-021..FA-027 (BK-059).
 * Each case is the audit's reproduction with the expectation inverted.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { type AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  deriveDeliveryId,
  MemoryWebhookStore,
  PINNED_ADDRESS,
  pinnedFetch,
  resolveAndValidate,
  verifySignature,
  signPayload,
  webhookOutboxDispatch,
  WebhookDeliverer,
  WebhookManager,
  WebhookUrlBlockedError,
  type WebhookEndpoint,
} from '../src/index.js'

const SECRET = 'x'.repeat(16)
const ok = () => vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 200 }))
const publicLookup = { lookup: async () => [{ address: '93.184.216.34', family: 4 }] }

describe('FA-021 — null secret/tenantId from SQL rows', () => {
  it('deliver() with secret:null and tenantId:null signs with the default secret instead of throwing', async () => {
    const fx = ok()
    const d = new WebhookDeliverer({ secret: SECRET, fetchImpl: fx as never, ssrf: false })
    const endpoint = { id: 'g', url: 'https://hook.example/', events: ['*'], secret: null, tenantId: null } as unknown as WebhookEndpoint
    const r = await d.deliver(endpoint, 'a.b', {})
    expect(r.ok).toBe(true)
    expect(fx).toHaveBeenCalledTimes(1)
  })

  it('tenantId:null is tenant-agnostic, not tenant-bound (no "no own secret" refusal)', async () => {
    const d = new WebhookDeliverer({ secret: SECRET, fetchImpl: ok() as never, ssrf: false })
    const r = await d.deliver({ id: 'g', url: 'https://hook.example/', events: ['*'], tenantId: null } as never, 'a.b', {})
    expect(r.ok).toBe(true)
    expect(r.error).toBeUndefined()
  })

  it('one endpoint whose delivery throws does not reject the whole dispatch', async () => {
    const fx = ok()
    const deliverer = new WebhookDeliverer({ secret: SECRET, fetchImpl: fx as never, ssrf: false })
    const real = deliverer.deliver.bind(deliverer)
    vi.spyOn(deliverer, 'deliver').mockImplementation(async (endpoint, event, data, options) => {
      if (endpoint.id === 'broken') throw new TypeError('boom')
      return real(endpoint, event, data, options)
    })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const mgr = new WebhookManager(new MemoryWebhookStore(), deliverer)
    await mgr.register({ id: 'broken', url: 'https://a.example/', events: ['*'] })
    await mgr.register({ id: 'good', url: 'https://b.example/', events: ['*'] })
    const results = await mgr.dispatch('x', {})
    errors.mockRestore()
    expect(results.find((r) => r.endpointId === 'good')?.ok).toBe(true)
    expect(results.find((r) => r.endpointId === 'broken')).toMatchObject({ ok: false, retryable: true, error: 'internal delivery error' })
  })

  it('list() reports hasSecret:false for a null secret', async () => {
    const store = new MemoryWebhookStore()
    await store.add({ id: 'n', url: 'https://hook.example/', events: ['*'], secret: null } as never)
    const mgr = new WebhookManager(store, new WebhookDeliverer({ secret: SECRET, ssrf: false }))
    expect((await mgr.list())[0]?.hasSecret).toBe(false)
  })
})

describe('FA-022 — unregister() re-verifies ownership', () => {
  it('a README-shaped store (remove(id) only) can no longer be used for a cross-tenant delete', async () => {
    class ReadmeStore extends MemoryWebhookStore {
      override remove(id: string) {
        return super.remove(id)
      }
    }
    const mgr = new WebhookManager(new ReadmeStore(), new WebhookDeliverer({ ssrf: false, secret: SECRET }))
    await mgr.register({ id: 'b1', url: 'https://hook.example/', events: ['*'], tenantId: 'globex', secret: SECRET })
    await mgr.unregister('b1', { tenantId: 'acme' })
    expect((await mgr.list('globex')).map((e) => e.id)).toEqual(['b1'])
  })

  it('fails closed even when the store list() ignores its tenant argument', async () => {
    class LeakyStore extends MemoryWebhookStore {
      override list() {
        return super.list()
      }
      override remove(id: string) {
        return super.remove(id)
      }
    }
    const mgr = new WebhookManager(new LeakyStore(), new WebhookDeliverer({ ssrf: false, secret: SECRET }))
    await mgr.register({ id: 'b1', url: 'https://hook.example/', events: ['*'], tenantId: 'globex', secret: SECRET })
    await mgr.unregister('b1', { tenantId: 'acme' })
    expect(await mgr.list('globex')).toHaveLength(1)
  })

  it('the owning tenant can still unregister its endpoint', async () => {
    const mgr = new WebhookManager(new MemoryWebhookStore(), new WebhookDeliverer({ ssrf: false, secret: SECRET }))
    await mgr.register({ id: 'a1', url: 'https://hook.example/', events: ['*'], tenantId: 'acme', secret: SECRET })
    await mgr.unregister('a1', { tenantId: 'acme' })
    expect(await mgr.list('acme')).toEqual([])
  })
})

describe('FA-023 — outbox: stable delivery id, permanent failures not re-dispatched', () => {
  const entry = { id: 'e1', event: 'x', payload: {}, attempts: 0, createdAt: 0 }

  it('a permanent failure (SSRF-blocked) does not re-queue the entry nor re-deliver to the healthy endpoint', async () => {
    const fx = ok()
    const mgr = new WebhookManager(
      new MemoryWebhookStore(),
      new WebhookDeliverer({ secret: SECRET, fetchImpl: fx as never, fetchImplPinsAddress: true, sleep: async () => {}, ssrf: publicLookup }),
    )
    await mgr.register({ id: 'good', url: 'https://good.example/', events: ['*'], secret: SECRET })
    await mgr.register({ id: 'bad', url: 'http://127.0.0.1/', events: ['*'], secret: SECRET })
    const onPermanentFailure = vi.fn()
    const dispatch = webhookOutboxDispatch(mgr, { onPermanentFailure })
    await expect(dispatch(entry)).resolves.toBeUndefined()
    expect(fx).toHaveBeenCalledTimes(1)
    expect(onPermanentFailure).toHaveBeenCalledWith(entry, [expect.objectContaining({ endpointId: 'bad', retryable: false })])
  })

  it('a transient failure re-queues; the retry skips the endpoint that already accepted and keeps the same id', async () => {
    let failFlaky = true
    const fx = vi.fn(async (url: string, _init: RequestInit) =>
      new Response(null, { status: url.includes('flaky') && failFlaky ? 503 : 200 }),
    )
    const mgr = new WebhookManager(
      new MemoryWebhookStore(),
      new WebhookDeliverer({ secret: SECRET, fetchImpl: fx as never, maxRetries: 0, ssrf: false }),
    )
    await mgr.register({ id: 'good', url: 'https://good.example/', events: ['*'], secret: SECRET })
    await mgr.register({ id: 'flaky', url: 'https://flaky.example/', events: ['*'], secret: SECRET })
    const dispatch = webhookOutboxDispatch(mgr)
    await expect(dispatch(entry)).rejects.toThrow(/transiently/)
    failFlaky = false
    await expect(dispatch(entry)).resolves.toBeUndefined()

    const sent = fx.mock.calls.map(([url, init]) => ({ url, id: JSON.parse(String(init.body)).id as string }))
    expect(sent.filter((s) => s.url.includes('good'))).toHaveLength(1)
    const flaky = sent.filter((s) => s.url.includes('flaky'))
    expect(flaky).toHaveLength(2)
    expect(flaky[0]!.id).toBe(flaky[1]!.id)
    expect(flaky[0]!.id).toBe(deriveDeliveryId('e1', 'flaky'))
  })

  it('the delivery id is stable across separate dispatchers (e.g. a restart) and differs per endpoint', async () => {
    const fx = ok()
    const mgr = new WebhookManager(new MemoryWebhookStore(), new WebhookDeliverer({ secret: SECRET, fetchImpl: fx as never, ssrf: false }))
    await mgr.register({ id: 'a', url: 'https://a.example/', events: ['*'], secret: SECRET })
    await webhookOutboxDispatch(mgr)(entry)
    await webhookOutboxDispatch(mgr)(entry)
    const ids = fx.mock.calls.map(([, init]) => JSON.parse(String(init.body)).id as string)
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(deriveDeliveryId('e1', 'a')).not.toBe(deriveDeliveryId('e1', 'b'))
  })

  it('4xx is permanent, 408/429 and exhausted 5xx are retryable', async () => {
    for (const [status, retryable] of [[400, false], [410, false], [408, true], [429, true], [503, true]] as const) {
      const d = new WebhookDeliverer({ secret: SECRET, maxRetries: 0, ssrf: false, fetchImpl: (async () => new Response(null, { status })) as never })
      const r = await d.deliver({ id: 'e', url: 'https://hook.example/', events: ['*'], secret: SECRET }, 'a.b', {})
      expect(r.retryable, `HTTP ${status}`).toBe(retryable)
    }
  })
})

describe('FA-024 — verifySignature() rejects an invalid tolerance', () => {
  it('throws on NaN / negative / non-finite tolerance and on a NaN clock instead of accepting any age', () => {
    const h = signPayload('b', SECRET, 1)
    expect(() => verifySignature(h, 'b', SECRET, NaN, 2_000_000_000)).toThrow(RangeError)
    expect(() => verifySignature(h, 'b', SECRET, -1, 2_000_000_000)).toThrow(RangeError)
    expect(() => verifySignature(h, 'b', SECRET, Infinity, 2_000_000_000)).toThrow(RangeError)
    expect(() => verifySignature(h, 'b', SECRET, 300, NaN)).toThrow(RangeError)
    expect(verifySignature(h, 'b', SECRET, 300, 2_000_000_000)).toBe(false)
    expect(verifySignature(h, 'b', SECRET, 300, 2)).toBe(true)
  })
})

describe('FA-025 — injected fetchImpl and DNS pinning', () => {
  let server: Server | undefined
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    server = undefined
  })

  it('pinnedFetch connects to the pinned address while keeping the original Host', async () => {
    const seen: string[] = []
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      seen.push(String(req.headers.host))
      res.writeHead(204).end()
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    // The hostname does not resolve at all; only the pin makes this connect.
    const res = await pinnedFetch(`http://rebind.invalid:${port}/hook`, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
      [PINNED_ADDRESS]: { address: '127.0.0.1', family: 4 },
    } as RequestInit)
    expect(res.status).toBe(204)
    expect(seen).toEqual([`rebind.invalid:${port}`])
  })

  it('the deliverer hands the validated pin to fetchImpl, so a pinnedFetch-delegating wrapper keeps it', async () => {
    const pins: unknown[] = []
    const wrapper = vi.fn(async (_url: string, init: RequestInit) => {
      pins.push((init as Record<symbol, unknown>)[PINNED_ADDRESS])
      return new Response(null, { status: 200 }) // stands in for `return pinnedFetch(url, init)`
    })
    const d = new WebhookDeliverer({ secret: SECRET, fetchImpl: wrapper as never, fetchImplPinsAddress: true, ssrf: publicLookup })
    const r = await d.deliver({ id: 'e', url: 'https://rebind.example/hook', events: ['*'], secret: SECRET }, 'a.b', {})
    expect(r.ok).toBe(true)
    expect(pins).toEqual([{ address: '93.184.216.34', family: 4 }])
  })

  it('an unpinned custom fetchImpl warns once and re-validates the host before each retry', async () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    let answer = '93.184.216.34'
    const lookup = vi.fn(async () => [{ address: answer, family: 4 }])
    const fx = vi.fn(async () => {
      answer = '10.0.0.7' // the attacker rebinds during backoff
      return new Response(null, { status: 503 })
    })
    const d = new WebhookDeliverer({ secret: SECRET, fetchImpl: fx as never, sleep: async () => {}, maxRetries: 2, ssrf: { lookup } })
    new WebhookDeliverer({ secret: SECRET, fetchImpl: fx as never, ssrf: { lookup } })
    const r = await d.deliver({ id: 'e', url: 'https://rebind.example/hook', events: ['*'], secret: SECRET }, 'a.b', {})
    expect(fx).toHaveBeenCalledTimes(1) // the retry was refused, never sent
    expect(r).toMatchObject({ ok: false, retryable: false })
    expect(r.error).not.toContain('10.0.0.7')
    const unpinned = warn.mock.calls.filter((c) => (c[1] as { code?: string } | undefined)?.code === 'BASALT_WEBHOOKS_UNPINNED_FETCH')
    expect(unpinned).toHaveLength(1) // two unpinned deliverers, one warning
    warn.mockRestore()
  })
})

describe('FA-026 — a blocked URL never echoes the resolved internal address', () => {
  it('resolveAndValidate() message omits the address (kept on resolvedAddress for server logs)', async () => {
    const error = await resolveAndValidate('https://db.internal/', { lookup: async () => [{ address: '10.1.2.3', family: 4 }] }).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(WebhookUrlBlockedError)
    expect((error as Error).message).not.toContain('10.1.2.3')
    expect((error as WebhookUrlBlockedError).resolvedAddress).toBe('10.1.2.3')
  })

  it('DeliveryResult.error is identical for "private" and "unresolvable" hosts and carries no address', async () => {
    const run = async (lookup: () => Promise<{ address: string; family: number }[]>) =>
      (await new WebhookDeliverer({ secret: SECRET, fetchImpl: ok() as never, ssrf: { lookup } }).deliver(
        { id: 'e', url: 'https://db.internal/', events: ['*'], secret: SECRET },
        'a.b',
        {},
      )).error
    const privateHost = await run(async () => [{ address: '10.1.2.3', family: 4 }])
    const missingHost = await run(async () => {
      throw new Error('ENOTFOUND')
    })
    expect(privateHost).not.toContain('10.1.2.3')
    expect(privateHost).toBe(missingHost)
  })
})

describe('FA-027 — each attempt is signed with its own timestamp', () => {
  it('a retry after 400 s of backoff still verifies within a 300 s tolerance', async () => {
    let t = 1000
    let n = 0
    const fx = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: n++ === 0 ? 500 : 200 }))
    const d = new WebhookDeliverer({ secret: SECRET, fetchImpl: fx as never, ssrf: false, now: () => t, sleep: async () => { t += 400 }, maxRetries: 1 })
    const r = await d.deliver({ id: 'e', url: 'https://hook.example/', events: ['*'], secret: SECRET }, 'a.b', {})
    expect(r.ok).toBe(true)
    const [first, second] = fx.mock.calls.map(([, init]) => init as { headers: Record<string, string>; body: string })
    expect(second!.headers['x-basalt-signature']).toMatch(/^t=1400,/)
    expect(verifySignature(second!.headers['x-basalt-signature']!, second!.body, SECRET, 300, t)).toBe(true)
    expect(first!.body).toBe(second!.body) // the signed body (and its id) is unchanged across retries
  })
})
