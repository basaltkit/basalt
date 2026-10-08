import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { RawBody } from '@basaltkit/http'
import { signPayload } from '@basaltkit/webhooks'
import {
  DEFAULT_INBOUND_MAX_REQUEST_BYTES,
  inboundCanonical,
  InboundMailMalformedError,
  InboundMailUnauthorizedError,
  InboundMailUnsupportedTypeError,
  signedDriver,
  signInboundMail,
} from '../src/index.js'
// The reference Worker the docs publish (the docs test below keeps them identical).
import worker, { signDelivery } from './fixtures/cloudflare-email-worker.js'

const SECRET = 'whsec_inbound_test_secret_0123456789'
const PREVIOUS = 'whsec_inbound_previous_secret_98765'
const envelope = { from: 'sender@example.org', to: 'Invoices@In.Example.com' }
const raw = Buffer.from('From: a@example.org\r\nSubject: caf\xe9\r\n\r\nol\xe1\r\n', 'latin1')
const now = () => Math.floor(Date.now() / 1000)

const body = (bytes: Uint8Array, contentType: string | null = 'message/rfc822'): RawBody => {
  const buffer = Buffer.from(bytes)
  return { bytes: buffer, contentType: contentType ?? undefined, contentLength: buffer.length, text: () => buffer.toString('utf8') }
}

describe('wire format v1 golden vector (RFC 0003 §3.1)', () => {
  const golden = {
    secret: 'whsec_golden_vector_secret_000000',
    t: 1767225600,
    envelope: { from: 'sender@example.org', to: 'invoices@in.example.com' },
    raw: Buffer.from(
      '46726f6d3a2061406578616d706c652e6f72670d0a546f3a20696e766f6963657340696e2e' +
        '6578616d706c652e636f6d0d0a5375626a6563743a20636166e90d0a436f6e74656e742d5472' +
        '616e736665722d456e636f64696e673a20386269740d0a0d0a6f6ce10d0a',
      'hex',
    ),
    canonicalSha256: '0fa4587fc4e0262710fba7a5740b79de53b19d863e62748592dc6b57d68f2913',
    header: 't=1767225600,v1=3050e2bf199d9a502990e01ff3af1043fcee57f6c5577620eff706f74f784755',
  }

  it('frames the canonical bytes exactly', () => {
    const canonical = inboundCanonical(golden.raw, golden.envelope)
    expect(canonical.byteLength).toBe(167)
    expect(createHash('sha256').update(canonical).digest('hex')).toBe(golden.canonicalSha256)
  })

  it('signs to the frozen header', () => {
    expect(signInboundMail(golden.raw, golden.envelope, golden.secret, { nowSeconds: golden.t })['x-basalt-signature']).toBe(golden.header)
  })

  it('the WebCrypto Worker signs to the same header', async () => {
    const headers = await signDelivery(new Uint8Array(golden.raw), golden.envelope.from, golden.envelope.to, undefined, golden.secret, golden.t)
    expect(headers['x-basalt-signature']).toBe(golden.header)
  })

  it('the documented Worker is the tested one, in both locales', () => {
    const fixture = readFileSync(fileURLToPath(new URL('./fixtures/cloudflare-email-worker.js', import.meta.url)), 'utf8').trim()
    for (const locale of ['guide', 'pt/guide']) {
      const doc = readFileSync(fileURLToPath(new URL(`../../../apps/docs/${locale}/inbound-mail.md`, import.meta.url)), 'utf8')
      const block = /```js\n(\/\/ Cloudflare Email Routing -> Basalt relay[\s\S]*?)```/.exec(doc)?.[1]?.trim()
      expect(block, `${locale}/inbound-mail.md`).toBe(fixture)
    }
  })
})

describe('signedDriver', () => {
  const driver = signedDriver({ secret: SECRET })

  it('round-trips signInboundMail → receive over non-UTF-8 bytes', async () => {
    const headers = signInboundMail(raw, envelope, SECRET)
    const mail = await driver.receive({ body: body(raw), headers })
    expect(Buffer.from(mail.raw).equals(raw)).toBe(true)
    expect(mail.envelope).toEqual({ from: 'sender@example.org', to: 'invoices@in.example.com' })
    expect(mail.source).toBe('signed')
    expect(mail.oversize).toBeUndefined()
    expect(mail.receivedAt).toBeInstanceOf(Date)
    expect(mail.deliveryKey).toBe(`${createHash('sha256').update(raw).digest('hex')}:invoices@in.example.com`)
    expect(driver.maxRequestBytes).toBe(DEFAULT_INBOUND_MAX_REQUEST_BYTES)
  })

  it('accepts the Worker relay end to end', async () => {
    const headers = await signDelivery(new Uint8Array(raw), envelope.from, envelope.to, undefined, SECRET, now())
    await expect(driver.receive({ body: body(raw), headers })).resolves.toMatchObject({ envelope: { to: 'invoices@in.example.com' } })
  })

  it('verifies with the previous secret during a rotation, and signs with both', async () => {
    const rotating = signedDriver({ secret: [SECRET, PREVIOUS] })
    await expect(rotating.receive({ body: body(raw), headers: signInboundMail(raw, envelope, PREVIOUS) })).resolves.toBeDefined()
    const both = signInboundMail(raw, envelope, [SECRET, PREVIOUS])
    expect(both['x-basalt-signature']!.match(/v1=/g)).toHaveLength(2)
    await expect(signedDriver({ secret: PREVIOUS }).receive({ body: body(raw), headers: both })).resolves.toBeDefined()
    await expect(driver.receive({ body: body(raw), headers: signInboundMail(raw, envelope, PREVIOUS) })).rejects.toBeInstanceOf(
      InboundMailUnauthorizedError,
    )
  })

  it('refuses a stale or future timestamp outside the tolerance', async () => {
    const stale = signInboundMail(raw, envelope, SECRET, { nowSeconds: now() - 301 })
    await expect(driver.receive({ body: body(raw), headers: stale })).rejects.toMatchObject({ status: 401 })
    const strict = signedDriver({ secret: SECRET, toleranceSeconds: 1000 })
    await expect(strict.receive({ body: body(raw), headers: stale })).resolves.toBeDefined()
  })

  it.each([
    ['a tampered byte', (h: Record<string, string>) => ({ h, b: Buffer.concat([raw, Buffer.from('x')]) })],
    ['a tampered recipient', (h: Record<string, string>) => ({ h: { ...h, 'x-basalt-mail-to': 'other@in.example.com' }, b: raw })],
    ['a tampered sender', (h: Record<string, string>) => ({ h: { ...h, 'x-basalt-mail-from': 'x@example.org' }, b: raw })],
    ['an added oversize', (h: Record<string, string>) => ({ h: { ...h, 'x-basalt-mail-oversize': '5' }, b: Buffer.alloc(0) })],
    ['a missing signature', (h: Record<string, string>) => ({ h: { ...h, 'x-basalt-signature': '' }, b: raw })],
    ['a garbage signature', (h: Record<string, string>) => ({ h: { ...h, 'x-basalt-signature': 'nope' }, b: raw })],
  ])('%s is a generic 401', async (_name, mutate) => {
    const { h, b } = mutate(signInboundMail(raw, envelope, SECRET))
    const error = await driver.receive({ body: body(b), headers: h }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InboundMailUnauthorizedError)
    expect(error).toMatchObject({ status: 401, code: 'INBOUND_MAIL_UNAUTHORIZED', message: 'The inbound mail delivery could not be authenticated.' })
    expect((error as InboundMailUnauthorizedError).details).toBeUndefined()
  })

  it('a tampered oversize value is a 401', async () => {
    const empty = new Uint8Array(0)
    const headers = signInboundMail(empty, envelope, SECRET, { oversize: 30_000_000 })
    const mail = await driver.receive({ body: body(empty), headers })
    expect(mail.oversize).toBe(30_000_000)
    expect(mail.raw.byteLength).toBe(0)
    expect(mail.deliveryKey).toMatch(/^oversize:[0-9a-f]{64}$/)
    await expect(driver.receive({ body: body(empty), headers: { ...headers, 'x-basalt-mail-oversize': '30000001' } })).rejects.toMatchObject({
      status: 401,
    })
  })

  it.each([
    ['CR/LF in the recipient', { 'x-basalt-mail-to': 'a@b.example\r\nx-evil: 1' }],
    ['LF in the sender', { 'x-basalt-mail-from': 'a@b\nc' }],
    ['a comma list', { 'x-basalt-mail-to': 'a@in.example.com,b@in.example.com' }],
    ['NUL', { 'x-basalt-mail-to': 'a\u0000@in.example.com' }],
    ['no @', { 'x-basalt-mail-to': 'nobody' }],
    ['no recipient', { 'x-basalt-mail-to': undefined }],
    ['a 321-character address', { 'x-basalt-mail-to': `${'a'.repeat(310)}@example.com` }],
    ['a repeated header', { 'x-basalt-mail-to': ['a@in.example.com', 'b@in.example.com'] }],
    ['a non-numeric oversize', { 'x-basalt-mail-oversize': '1e3' }],
    ['a zero oversize', { 'x-basalt-mail-oversize': '0' }],
  ])('%s is a 400 before any signature check', async (_name, override) => {
    const headers = { ...signInboundMail(raw, envelope, SECRET), ...override }
    const error = await driver.receive({ body: body(raw), headers }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InboundMailMalformedError)
    expect(error).toMatchObject({ status: 400, code: 'INBOUND_MAIL_MALFORMED' })
  })

  it('an oversize notice that carries the message is a 400', async () => {
    const headers = { ...signInboundMail(new Uint8Array(0), envelope, SECRET, { oversize: 99 }) }
    await expect(driver.receive({ body: body(raw), headers })).rejects.toMatchObject({ status: 400 })
  })

  it('a header that appears twice under different cases is a 400', async () => {
    const headers = { ...signInboundMail(raw, envelope, SECRET), 'X-Basalt-Mail-To': 'other@in.example.com' }
    await expect(driver.receive({ body: body(raw), headers })).rejects.toMatchObject({ status: 400 })
  })

  it('a single-element array header is read as that value', async () => {
    const signed = signInboundMail(raw, envelope, SECRET)
    const headers = { ...signed, 'x-basalt-signature': [signed['x-basalt-signature']!] }
    await expect(driver.receive({ body: body(raw), headers })).resolves.toBeDefined()
  })

  it('an empty MAIL FROM (a bounce) is accepted', async () => {
    const bounce = { from: '', to: 'acme@in.example.com' }
    const headers = signInboundMail(raw, bounce, SECRET)
    const { 'x-basalt-mail-from': _omitted, ...withoutFrom } = headers
    await expect(driver.receive({ body: body(raw), headers })).resolves.toMatchObject({ envelope: { from: '' } })
    await expect(driver.receive({ body: body(raw), headers: withoutFrom })).resolves.toMatchObject({ envelope: { from: '' } })
  })

  it.each([null, 'text/plain', 'application/json'])('content type %s is a 415', async (type) => {
    const error = await driver.receive({ body: body(raw, type), headers: signInboundMail(raw, envelope, SECRET) }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InboundMailUnsupportedTypeError)
    expect(error).toMatchObject({ status: 415, code: 'INBOUND_MAIL_UNSUPPORTED_TYPE' })
  })

  it('accepts application/octet-stream', async () => {
    await expect(driver.receive({ body: body(raw, 'application/octet-stream'), headers: signInboundMail(raw, envelope, SECRET) })).resolves.toBeDefined()
  })

  it('custom header names on both sides', async () => {
    const names = { signature: 'x-sig', from: 'x-from', to: 'x-to', oversize: 'x-big' }
    const custom = signedDriver({ secret: SECRET, headers: names })
    const headers = signInboundMail(raw, envelope, SECRET, { headers: names })
    expect(Object.keys(headers).sort()).toEqual(['content-type', 'x-from', 'x-sig', 'x-to'])
    await expect(custom.receive({ body: body(raw), headers })).resolves.toBeDefined()
  })

  it('the framing is the webhook signature over canonical bytes', async () => {
    const t = now()
    const headers = {
      'x-basalt-signature': signPayload(inboundCanonical(raw, envelope), SECRET, t),
      'x-basalt-mail-from': envelope.from,
      'x-basalt-mail-to': envelope.to,
    }
    await expect(driver.receive({ body: body(raw), headers })).resolves.toBeDefined()
  })

  it('fails closed on configuration', () => {
    expect(() => signedDriver({ secret: 'short' })).toThrow(/at least 16/)
    expect(() => signedDriver({ secret: [SECRET, 'short'] })).toThrow(TypeError)
    expect(() => signedDriver({ secret: [] })).toThrow(/at least one secret/)
    expect(() => signedDriver({ secret: SECRET, toleranceSeconds: Number.NaN })).toThrow(/toleranceSeconds/)
    expect(() => signedDriver({ secret: SECRET, toleranceSeconds: -1 })).toThrow(/toleranceSeconds/)
    expect(() => signedDriver({ secret: SECRET, maxRequestBytes: 0 })).toThrow(/maxRequestBytes/)
    expect(signedDriver({ secret: SECRET, maxRequestBytes: 50 * 1024 * 1024 }).maxRequestBytes).toBe(50 * 1024 * 1024)
    expect(() => signInboundMail(raw, envelope, 'short')).toThrow(TypeError)
    expect(() => signInboundMail(raw, { from: 'a', to: 'b@c\nd' }, SECRET)).toThrow(/single address/)
    expect(() => inboundCanonical(raw, envelope, 10)).toThrow(/must not carry/)
    expect(() => inboundCanonical(new Uint8Array(0), envelope, -1)).toThrow(/positive integer/)
    expect(() => inboundCanonical(raw, { from: 1 as unknown as string, to: 'a@b' })).toThrow(/must be a string/)
  })
})

describe('the reference Worker', () => {
  type Sent = { url: string; init: RequestInit }
  const run = async (status: number, rawSize: number) => {
    const sent: Sent[] = []
    const rejected: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent.push({ url, init })
      return new Response(null, { status })
    }) as typeof fetch
    try {
      const message = {
        from: envelope.from,
        to: envelope.to,
        raw: new Response(raw).body,
        rawSize,
        setReject: (reason: string) => void rejected.push(reason),
      }
      const outcome = await worker.email(message, { BASALT_INBOUND_URL: 'https://api.example.com/inbound/mail', BASALT_INBOUND_SECRET: SECRET }).then(
        () => 'ok',
        (error: Error) => error.message,
      )
      return { sent, rejected, outcome }
    } finally {
      globalThis.fetch = realFetch
    }
  }

  it('posts the signed bytes, which the driver accepts', async () => {
    const { sent, outcome } = await run(200, raw.length)
    expect(outcome).toBe('ok')
    const headers = sent[0]!.init.headers as Record<string, string>
    const bytes = sent[0]!.init.body as Uint8Array
    await expect(signedDriver({ secret: SECRET }).receive({ body: body(bytes), headers })).resolves.toMatchObject({ raw: expect.any(Buffer) })
  })

  it('sends a signed oversize notice instead of a huge message', async () => {
    const { sent } = await run(200, 11 * 1024 * 1024)
    const headers = sent[0]!.init.headers as Record<string, string>
    expect((sent[0]!.init.body as Uint8Array).byteLength).toBe(0)
    const mail = await signedDriver({ secret: SECRET }).receive({ body: body(new Uint8Array(0)), headers })
    expect(mail.oversize).toBe(11 * 1024 * 1024)
  })

  it('a 5xx or a 401 is a temporary failure; another 4xx bounces', async () => {
    expect((await run(500, raw.length)).outcome).toMatch(/500/)
    expect((await run(401, raw.length)).outcome).toMatch(/401/)
    const bounced = await run(422, raw.length)
    expect(bounced.outcome).toBe('ok')
    expect(bounced.rejected).toEqual(['rejected (422)'])
  })
})
