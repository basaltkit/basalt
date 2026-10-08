/**
 * BK-084 — operable webhooks: sealed secrets at rest, per-attempt telemetry,
 * a configurable header prefix.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_WEBHOOK_HEADER_PREFIX,
  MemoryWebhookStore,
  verifySignature,
  WebhookDeliverer,
  WebhookManager,
  webhookHeaderNames,
  WebhookSecretNotSealedError,
  type WebhookAttempt,
  type WebhookSecretBox,
  type WebhookSecretContext,
} from '../src/index.js'

const publicLookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])
const noSleep = async () => {}
const respond = (...statuses: number[]) => {
  let i = 0
  return vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: statuses[Math.min(i++, statuses.length - 1)]! }))
}
const headersOf = (fx: ReturnType<typeof respond>, call = -1) => fx.mock.calls.at(call)![1].headers as Record<string, string>
const bodyOf = (fx: ReturnType<typeof respond>, call = -1) => fx.mock.calls.at(call)![1].body as string

/** A real AES-256-GCM box binding endpoint and tenant as AAD — the shape an app would supply. */
function aesBox(): WebhookSecretBox & { calls: { seal: number; open: number } } {
  const key = randomBytes(32)
  const aad = (c: WebhookSecretContext) => Buffer.from(`${c.endpointId}\0${c.tenantId ?? ''}`)
  const calls = { seal: 0, open: 0 }
  return {
    calls,
    seal(plain, context) {
      calls.seal++
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(aad(context))
      const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      return `sealed:v1:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url')}`
    },
    open(sealed, context) {
      calls.open++
      if (!sealed.startsWith('sealed:v1:')) throw new WebhookSecretNotSealedError()
      const raw = Buffer.from(sealed.slice('sealed:v1:'.length), 'base64url')
      const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
      decipher.setAAD(aad(context))
      decipher.setAuthTag(raw.subarray(12, 28))
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
    },
  }
}

function setup(options: { box?: WebhookSecretBox; clock?: { now: number } } = {}) {
  const clock = options.clock ?? { now: Date.UTC(2026, 9, 1) }
  const fx = respond(200)
  const deliverer = new WebhookDeliverer({
    fetchImpl: fx as never,
    fetchImplPinsAddress: true,
    ssrf: { lookup: publicLookup },
    now: () => Math.floor(clock.now / 1000),
  })
  const store = new MemoryWebhookStore()
  const mgr = new WebhookManager(store, deliverer, { now: () => clock.now, ...(options.box ? { secretBox: options.box } : {}) })
  return { fx, store, mgr, clock }
}

describe('BK-084 — sealed secrets (secretBox)', () => {
  it('round-trips: register stores ciphertext, returns plaintext, and deliveries sign with the plaintext', async () => {
    const box = aesBox()
    const { fx, store, mgr, clock } = setup({ box })
    const registered = await mgr.register({ url: 'https://hook.example/', events: ['*'], tenantId: 'acme' })
    expect(registered.secret).toMatch(/^whsec_/)

    const [row] = await store.list('acme')
    expect(row!.secret).toMatch(/^sealed:v1:/)
    expect(row!.secret).not.toContain(registered.secret!)

    const [result] = await mgr.dispatch('a.b', {}, 'acme')
    expect(result!.ok).toBe(true)
    expect(verifySignature(headersOf(fx)['x-basalt-signature']!, bodyOf(fx), registered.secret!, 300, Math.floor(clock.now / 1000))).toBe(true)
  })

  it('binds the endpoint: a sealed secret copied onto another endpoint does not open', async () => {
    const box = aesBox()
    const { store, mgr } = setup({ box })
    const a = await mgr.register({ url: 'https://a.example/', events: ['*'], tenantId: 'acme' })
    await mgr.register({ url: 'https://b.example/', events: ['*'], tenantId: 'acme', id: 'b' })
    const sealedA = (await store.list('acme')).find((e) => e.id === a.id)!.secret!
    const b = (await store.list('acme')).find((e) => e.id === 'b')!
    await store.add({ ...b, secret: sealedA })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const results = await mgr.dispatch('x', {}, 'acme')
    errors.mockRestore()
    expect(results.find((r) => r.endpointId === 'b')).toMatchObject({ ok: false, retryable: true, error: 'could not open the endpoint signing secret' })
    expect(results.find((r) => r.endpointId === a.id)!.ok).toBe(true)
  })

  it('a caller-supplied secret is sealed too, and never stored as plaintext', async () => {
    const { store, mgr } = setup({ box: aesBox() })
    const secret = 'whsec_caller_supplied_0123456789'
    const e = await mgr.register({ url: 'https://hook.example/', events: ['*'], tenantId: 'acme', secret })
    expect(e.secret).toBe(secret)
    expect(JSON.stringify(await store.list())).not.toContain(secret)
  })

  it('rotation seals both the new and the previous secret, and both sign during the grace window', async () => {
    const box = aesBox()
    const { fx, store, mgr, clock } = setup({ box })
    const e = await mgr.register({ url: 'https://hook.example/', events: ['*'], tenantId: 'acme' })
    const rotated = await mgr.rotateSecret(e.id, { tenantId: 'acme', graceSeconds: 3600 })
    expect(rotated.secret).toMatch(/^whsec_/)
    expect(rotated.secret).not.toBe(e.secret)

    const [row] = await store.list('acme')
    expect(row!.secret).toMatch(/^sealed:v1:/)
    expect(row!.previousSecret).toMatch(/^sealed:v1:/)
    expect(JSON.stringify(row)).not.toContain(e.secret!)
    expect(JSON.stringify(row)).not.toContain(rotated.secret!)

    await mgr.dispatch('a.b', {}, 'acme')
    const header = headersOf(fx)['x-basalt-signature']!
    const nowS = Math.floor(clock.now / 1000)
    expect(header.match(/v1=/g)).toHaveLength(2)
    expect(verifySignature(header, bodyOf(fx), e.secret!, 300, nowS)).toBe(true)
    expect(verifySignature(header, bodyOf(fx), rotated.secret!, 300, nowS)).toBe(true)

    // Past the window the previous secret is not even opened.
    clock.now += 3_600_001
    const opensBefore = box.calls.open
    await mgr.dispatch('a.b', {}, 'acme')
    expect(box.calls.open - opensBefore).toBe(1)
    expect(headersOf(fx)['x-basalt-signature']!.match(/v1=/g)).toHaveLength(1)
  })

  it('legacy plaintext rows keep delivering and are sealed on the next rotation', async () => {
    const box = aesBox()
    const { fx, store, mgr, clock } = setup({ box })
    const legacy = 'whsec_legacy_plaintext_0123456789'
    await store.add({ id: 'old', url: 'https://hook.example/', events: ['*'], tenantId: 'acme', secret: legacy })

    const [result] = await mgr.dispatch('a.b', {}, 'acme')
    expect(result!.ok).toBe(true)
    expect(verifySignature(headersOf(fx)['x-basalt-signature']!, bodyOf(fx), legacy, 300, Math.floor(clock.now / 1000))).toBe(true)

    const rotated = await mgr.rotateSecret('old', { tenantId: 'acme' })
    const [row] = await store.list('acme')
    expect(row!.secret).toMatch(/^sealed:v1:/)
    expect(row!.previousSecret).toMatch(/^sealed:v1:/) // the legacy plaintext, now sealed
    expect(JSON.stringify(row)).not.toContain(legacy)
    await mgr.dispatch('a.b', {}, 'acme')
    const nowS = Math.floor(clock.now / 1000)
    expect(verifySignature(headersOf(fx)['x-basalt-signature']!, bodyOf(fx), legacy, 300, nowS)).toBe(true)
    expect(verifySignature(headersOf(fx)['x-basalt-signature']!, bodyOf(fx), rotated.secret!, 300, nowS)).toBe(true)
  })

  it('isSealed() short-circuits legacy detection without calling open()', async () => {
    const inner = aesBox()
    const box: WebhookSecretBox = { seal: inner.seal, open: inner.open, isSealed: (v) => v.startsWith('sealed:') }
    const { store, mgr } = setup({ box })
    await store.add({ id: 'old', url: 'https://hook.example/', events: ['*'], secret: 'whsec_legacy_plaintext_0123456789' })
    const [result] = await mgr.dispatch('a.b', {})
    expect(result!.ok).toBe(true)
    expect(inner.calls.open).toBe(0)
  })

  it('any other open() failure fails the delivery as retryable without leaking the stored value', async () => {
    const box: WebhookSecretBox = {
      seal: (plain) => `sealed:${Buffer.from(plain).toString('base64')}`,
      open: () => {
        throw new Error('KMS unavailable')
      },
    }
    const { fx, mgr } = setup({ box })
    await mgr.register({ url: 'https://hook.example/', events: ['*'], tenantId: 'acme' })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const [result] = await mgr.dispatch('a.b', {}, 'acme')
    errors.mockRestore()
    expect(result).toMatchObject({ ok: false, attempts: 0, retryable: true })
    expect(result!.error).not.toContain('sealed:')
    expect(fx).not.toHaveBeenCalled()
  })

  it('refuses a malformed secretBox at construction', () => {
    const deliverer = new WebhookDeliverer({ allowUnsigned: true })
    expect(() => new WebhookManager(new MemoryWebhookStore(), deliverer, { secretBox: {} as never })).toThrow(TypeError)
  })

  it('without a secretBox, secrets are stored as given (unchanged behaviour)', async () => {
    const { store, mgr } = setup()
    const e = await mgr.register({ url: 'https://hook.example/', events: ['*'], tenantId: 'acme' })
    expect((await store.list('acme'))[0]!.secret).toBe(e.secret)
  })
})

describe('BK-084 — attempt telemetry', () => {
  it('reports every attempt and the total duration on the result', async () => {
    const fx = respond(503, 502, 200)
    const attempts: WebhookAttempt[] = []
    const deliverer = new WebhookDeliverer({
      secret: 's'.repeat(16),
      fetchImpl: fx as never,
      fetchImplPinsAddress: true,
      ssrf: { lookup: publicLookup },
      sleep: noSleep,
      onAttempt: (a) => void attempts.push(a),
    })
    const result = await deliverer.deliver({ id: 'e1', url: 'https://hook.example/', events: ['*'] }, 'order.paid', {}, { deliveryId: 'd-1' })
    expect(result).toMatchObject({ ok: true, status: 200, attempts: 3 })
    expect(typeof result.durationMs).toBe('number')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(attempts.map((a) => [a.attempt, a.status, a.ok, a.error])).toEqual([
      [1, 503, false, 'HTTP 503'],
      [2, 502, false, 'HTTP 502'],
      [3, 200, true, undefined],
    ])
    for (const a of attempts) {
      expect(a).toMatchObject({ deliveryId: 'd-1', endpointId: 'e1', event: 'order.paid' })
      expect(a.tenantId).toBeUndefined()
      expect(a.at).toBeInstanceOf(Date)
      expect(a.durationMs).toBeGreaterThanOrEqual(0)
    }
  })

  it('reports network errors and the endpoint tenant; a throwing or rejecting hook never changes the outcome', async () => {
    const fx = vi.fn(async () => {
      throw new Error('ECONNRESET')
    })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen: WebhookAttempt[] = []
    let n = 0
    const deliverer = new WebhookDeliverer({
      fetchImpl: fx as never,
      fetchImplPinsAddress: true,
      ssrf: { lookup: publicLookup },
      sleep: noSleep,
      maxRetries: 1,
      onAttempt: (a) => {
        seen.push(a)
        if (n++ === 0) throw new Error('hook bug')
        return Promise.reject(new Error('async hook bug'))
      },
    })
    const result = await deliverer.deliver({ id: 'e1', url: 'https://hook.example/', events: ['*'], tenantId: 'acme', secret: 'x'.repeat(16) }, 'e', {})
    await new Promise((resolve) => setImmediate(resolve))
    const hookFailures = errors.mock.calls.length
    errors.mockRestore()
    expect(hookFailures).toBe(2)
    expect(result).toMatchObject({ ok: false, attempts: 2, error: 'ECONNRESET', retryable: true })
    expect(seen.map((a) => [a.attempt, a.ok, a.error, a.tenantId])).toEqual([
      [1, false, 'ECONNRESET', 'acme'],
      [2, false, 'ECONNRESET', 'acme'],
    ])
  })

  it('a refusal before any attempt fires no attempt but still carries durationMs', async () => {
    const onAttempt = vi.fn()
    const deliverer = new WebhookDeliverer({ onAttempt, ssrf: { lookup: publicLookup } })
    const result = await deliverer.deliver({ id: 'e1', url: 'https://hook.example/', events: ['*'] }, 'e', {})
    expect(result).toMatchObject({ ok: false, attempts: 0, retryable: false })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(onAttempt).not.toHaveBeenCalled()
  })

  it('reaches the plugin options (WebhooksPluginOptions extends the deliverer options)', async () => {
    const fx = respond(410)
    const onAttempt = vi.fn()
    const deliverer = new WebhookDeliverer({ fetchImpl: fx as never, fetchImplPinsAddress: true, ssrf: { lookup: publicLookup }, onAttempt })
    const mgr = new WebhookManager(new MemoryWebhookStore(), deliverer)
    await mgr.register({ url: 'https://hook.example/', events: ['*'], tenantId: 'acme' })
    const [result] = await mgr.dispatch('x', {}, 'acme')
    expect(result).toMatchObject({ ok: false, status: 410, retryable: false })
    expect(onAttempt).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, status: 410, ok: false, tenantId: 'acme' }))
  })
})

describe('BK-084 — header prefix', () => {
  it('defaults to x-basalt', () => {
    expect(DEFAULT_WEBHOOK_HEADER_PREFIX).toBe('x-basalt')
    expect(webhookHeaderNames()).toEqual({ event: 'x-basalt-event', delivery: 'x-basalt-delivery', signature: 'x-basalt-signature' })
  })

  it('a sender and a receiver with the same custom prefix interoperate', async () => {
    const fx = respond(200)
    const secret = 'whsec_prefix_0123456789abcdef'
    const deliverer = new WebhookDeliverer({ headerPrefix: 'x-acme', fetchImpl: fx as never, fetchImplPinsAddress: true, ssrf: { lookup: publicLookup }, now: () => 1000 })
    await deliverer.deliver({ id: 'e1', url: 'https://hook.example/', events: ['*'], secret }, 'invoice.paid', { n: 1 }, { deliveryId: 'd-9' })
    const sent = headersOf(fx)
    expect(Object.keys(sent).filter((h) => h.startsWith('x-basalt'))).toEqual([])

    // Receiver side: the same prefix names the same headers.
    const names = webhookHeaderNames('x-acme')
    expect(sent[names.event]).toBe('invoice.paid')
    expect(sent[names.delivery]).toBe('d-9')
    expect(verifySignature(sent[names.signature]!, bodyOf(fx), secret, 300, 1000)).toBe(true)
  })

  it.each(['', 'X-Acme', '1abc', 'x_acme', 'x acme', 'a'.repeat(33), 'x-acme\r\n'])('rejects the invalid prefix %j', (prefix) => {
    expect(() => webhookHeaderNames(prefix)).toThrow(TypeError)
    expect(() => new WebhookDeliverer({ headerPrefix: prefix, allowUnsigned: true })).toThrow(TypeError)
  })
})
