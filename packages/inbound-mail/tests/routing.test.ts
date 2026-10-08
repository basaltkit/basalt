import { describe, expect, it, vi } from 'vitest'
import { HookBus } from '@basaltkit/core'
import type { BasaltRoute, HttpReply, RawBody } from '@basaltkit/http'
import { compileAddressPattern, splitAddress } from '../src/routing.js'
import {
  inboundMailRoutes,
  InboundMailLimitError,
  signedDriver,
  signInboundMail,
  type InboundMail,
  type InboundMailContext,
  type InboundMailDriver,
} from '../src/index.js'
import { eml } from './helpers.js'

describe('address patterns', () => {
  it('matches an exact address case-insensitively and splits the +tag', () => {
    const match = compileAddressPattern('Invoices@In.Example.com')
    expect(match('INVOICES+acme-2026@in.example.COM')).toEqual({
      address: 'invoices+acme-2026@in.example.com',
      local: 'invoices',
      tag: 'acme-2026',
      domain: 'in.example.com',
      params: {},
    })
    expect(match('invoices@in.example.com.evil')).toBeUndefined()
    expect(match('xinvoices@in.example.com')).toBeUndefined()
  })

  it('captures {param} in the local part and in the domain, case-preserving names', () => {
    expect(compileAddressPattern('{tenantId}@in.example.com')('Acme_1@in.example.com')?.params).toEqual({ tenantId: 'acme_1' })
    expect(compileAddressPattern('invoices@{tenant}.in.example.com')('invoices@acme.in.example.com')?.params).toEqual({ tenant: 'acme' })
    expect(compileAddressPattern('{box}-{tenant}@x.example')('in-acme@x.example')?.params).toEqual({ box: 'in', tenant: 'acme' })
  })

  it('a capture outside [a-z0-9_-]{1,63} is a non-match', () => {
    const match = compileAddressPattern('{tenant}@in.example.com')
    expect(match('a.b@in.example.com')).toBeUndefined()
    expect(match('"x y"@in.example.com')).toBeUndefined()
    expect(match('a%b@in.example.com')).toBeUndefined()
    expect(match(`${'a'.repeat(64)}@in.example.com`)).toBeUndefined()
    expect(match(`${'a'.repeat(63)}@in.example.com`)).toBeDefined()
    expect(compileAddressPattern('in@{tenant}.example.com')('in@a.b.example.com')).toBeUndefined()
  })

  it('escapes regex metacharacters in literals', () => {
    expect(compileAddressPattern('a.b@x.example')('aXb@x.example')).toBeUndefined()
  })

  it('a predicate receives the full lower-cased address', () => {
    const predicate = vi.fn((address: string) => (address.endsWith('@special.example') ? { kind: 'special' } : false))
    const match = compileAddressPattern(predicate)
    expect(match('Box+T@Special.example')).toMatchObject({ local: 'box', tag: 't', params: { kind: 'special' } })
    expect(predicate).toHaveBeenCalledWith('box+t@special.example')
    expect(match('box@other.example')).toBeUndefined()
    expect(match('not-an-address')).toBeUndefined()
  })

  it.each(['no-at', '@domain', 'local@', 'a+{t}@x.example', '{}@x.example', '{1x}@x.example', '{a@x.example', 'a}@x.example', '{a}{a}@x.example'])(
    'rejects the pattern %j at construction',
    (pattern) => {
      expect(() => compileAddressPattern(pattern)).toThrow(TypeError)
    },
  )

  it('rejects a non-string, non-function pattern', () => {
    expect(() => compileAddressPattern(42 as unknown as string)).toThrow(TypeError)
  })

  it('splitAddress refuses what is not local@domain', () => {
    expect(splitAddress('nope')).toBeUndefined()
    expect(splitAddress('a@')).toBeUndefined()
    expect(compileAddressPattern('a@x.example')('nope')).toBeUndefined()
  })
})

const SECRET = 'whsec_inbound_test_secret_0123456789'
const message = eml(['From: a@example.org', 'To: acme@in.example.com', 'Subject: hi'], 'hello')

/** Calls the route's handler directly, the way an adapter would after `rawBody()` read the bytes. */
async function deliver(routes: BasaltRoute[], bytes: Uint8Array, headers: Record<string, string>) {
  const buffer = Buffer.from(bytes)
  const body: RawBody = { bytes: buffer, contentType: headers['content-type'], contentLength: buffer.length, text: () => buffer.toString() }
  let status = 0
  let sent: unknown
  const reply = {
    code(value: number) {
      status = value
      return reply
    },
    header() {
      return reply
    },
    send(value: unknown) {
      sent = value
      return value
    },
  } as unknown as HttpReply
  await routes[0]!.handler({ body, query: undefined, params: undefined, request: { headers } as never, reply })
  return { status, sent }
}

const signed = (to: string, bytes: Uint8Array = message) => signInboundMail(bytes, { from: 'a@example.org', to }, SECRET)

describe('inboundMailRoutes', () => {
  const driver = signedDriver({ secret: SECRET })

  it('builds one POST rawBody route with meta merged over { auth: false }', () => {
    const [route, ...rest] = inboundMailRoutes({ driver, routes: [{ address: 'a@x.example', handler() {} }], meta: { rateLimit: { max: 5 } } })
    expect(rest).toEqual([])
    expect(route).toMatchObject({ method: 'POST', url: '/inbound/mail', meta: { auth: false, rateLimit: { max: 5 } } })
    expect(inboundMailRoutes({ driver, routes: [{ address: 'a@x.example', handler() {} }], url: '/mail/in' })[0]!.url).toBe('/mail/in')
  })

  it('fails closed on configuration', () => {
    expect(() => inboundMailRoutes({ driver, routes: [] })).toThrow(/at least one route/)
    expect(() => inboundMailRoutes({ driver: undefined as unknown as InboundMailDriver, routes: [] })).toThrow(/driver/)
    expect(() => inboundMailRoutes({ driver, routes: [{ address: 'a@x.example' } as never] })).toThrow(/handler/)
    expect(() => inboundMailRoutes({ driver, routes: [{ address: 'bad', handler() {} }] })).toThrow(TypeError)
  })

  it('routes by the signed recipient; the first match wins', async () => {
    const seen: string[] = []
    const routes = inboundMailRoutes({
      driver,
      routes: [
        { address: 'billing@in.example.com', handler: () => void seen.push('billing') },
        { address: '{tenant}@in.example.com', handler: (ctx) => void seen.push(`tenant:${ctx.match.params['tenant']}`) },
        { address: 'billing@in.example.com', handler: () => void seen.push('never') },
      ],
    })
    expect(await deliver(routes, message, signed('Billing+x@in.example.com'))).toEqual({ status: 200, sent: { accepted: true } })
    await deliver(routes, message, signed('acme@in.example.com'))
    expect(seen).toEqual(['billing', 'tenant:acme'])
  })

  it('unrouted and invalid captures get the same 200 body, onUnrouted and the hook', async () => {
    const hooks = new HookBus()
    const unroutedHook = vi.fn()
    hooks.on('inbound-mail:unrouted', unroutedHook)
    const onUnrouted = vi.fn()
    const handler = vi.fn()
    const routes = inboundMailRoutes({ driver, hooks, onUnrouted, routes: [{ address: '{tenant}@in.example.com', handler }] })
    const routed = await deliver(routes, message, signed('acme@in.example.com'))
    const unrouted = await deliver(routes, message, signed('a.b@in.example.com'))
    const elsewhere = await deliver(routes, message, signed('acme@other.example'))
    expect(unrouted).toEqual(routed)
    expect(elsewhere).toEqual(routed)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(onUnrouted).toHaveBeenCalledWith('a.b@in.example.com', expect.objectContaining({ source: 'signed' }))
    expect(unroutedHook).toHaveBeenCalledTimes(2)
    // No address and no content in the hook payload.
    expect(unroutedHook.mock.calls[0]![0]).toEqual({ source: 'signed', digest: expect.stringMatching(/^[0-9a-f]{8}$/) })
  })

  it('parse() is memoised and uses the configured options', async () => {
    let first: unknown
    let second: unknown
    const routes = inboundMailRoutes({
      driver,
      parse: { trustedAuthservIds: ['mx.example'] },
      routes: [
        {
          address: 'acme@in.example.com',
          async handler(ctx) {
            first = await ctx.parse()
            second = await ctx.parse()
          },
        },
      ],
    })
    const bytes = eml(['Authentication-Results: mx.example; dmarc=pass', 'Subject: s'])
    await deliver(routes, bytes, signed('acme@in.example.com', bytes))
    expect(first).toBe(second)
    expect(first).toMatchObject({ subject: 's', auth: { dmarc: 'pass' } })
  })

  it('a parse limit surfaces as 422 from the handler', async () => {
    const routes = inboundMailRoutes({
      driver,
      parse: { maxRawBytes: 10 },
      routes: [{ address: 'acme@in.example.com', handler: async (ctx) => void (await ctx.parse()) }],
    })
    await expect(deliver(routes, message, signed('acme@in.example.com'))).rejects.toBeInstanceOf(InboundMailLimitError)
  })

  it('an oversize notice reaches the handler; parse() on it is a 400', async () => {
    let ctxSeen: InboundMailContext | undefined
    const routes = inboundMailRoutes({ driver, routes: [{ address: 'acme@in.example.com', handler: (ctx) => void (ctxSeen = ctx) }] })
    const empty = new Uint8Array(0)
    const headers = signInboundMail(empty, { from: 'a@example.org', to: 'acme@in.example.com' }, SECRET, { oversize: 12_000_000 })
    expect((await deliver(routes, empty, headers)).status).toBe(200)
    expect(ctxSeen!.mail.oversize).toBe(12_000_000)
    await expect(ctxSeen!.parse()).rejects.toMatchObject({ status: 400, code: 'INBOUND_MAIL_MALFORMED' })
  })

  it('deliveryKey is stable across retries and differs per recipient', async () => {
    const keys: string[] = []
    const routes = inboundMailRoutes({ driver, routes: [{ address: '{t}@in.example.com', handler: (ctx) => void keys.push(ctx.mail.deliveryKey) }] })
    await deliver(routes, message, signed('acme@in.example.com'))
    await deliver(routes, message, signInboundMail(message, { from: 'a@example.org', to: 'acme@in.example.com' }, SECRET, { nowSeconds: Math.floor(Date.now() / 1000) - 60 }))
    await deliver(routes, message, signed('globex@in.example.com'))
    expect(keys[0]).toBe(keys[1])
    expect(keys[2]).not.toBe(keys[0])
    expect(keys[2]!.endsWith(':globex@in.example.com')).toBe(true)
  })

  it('a refused delivery emits inbound-mail:rejected with the reason, no address, and rethrows', async () => {
    const hooks = new HookBus()
    const rejected = vi.fn()
    hooks.on('inbound-mail:rejected', rejected)
    const routes = inboundMailRoutes({ driver, hooks, routes: [{ address: 'acme@in.example.com', handler() {} }] })
    const headers = { ...signed('acme@in.example.com'), 'x-basalt-signature': 't=1,v1=00' }
    await expect(deliver(routes, message, headers)).rejects.toMatchObject({ status: 401 })
    expect(rejected).toHaveBeenCalledWith({ reason: 'unauthorized', source: 'signed', detail: 'bad-signature', digest: expect.stringMatching(/^[0-9a-f]{8}$/) })
    await expect(deliver(routes, message, { ...signed('acme@in.example.com'), 'content-type': 'text/plain' })).rejects.toMatchObject({ status: 415 })
    expect(rejected).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'unsupported-type' }))
    await expect(deliver(routes, message, { ...signed('acme@in.example.com'), 'x-basalt-mail-to': 'x' })).rejects.toMatchObject({ status: 400 })
    expect(rejected).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'malformed', detail: 'envelope-invalid' }))
  })

  it('a failing rejected-hook observer does not change the refusal', async () => {
    const hooks = new HookBus()
    hooks.on('inbound-mail:rejected', () => {
      throw new Error('observer down')
    })
    const routes = inboundMailRoutes({ driver, hooks, routes: [{ address: 'acme@in.example.com', handler() {} }] })
    await expect(deliver(routes, message, { ...signed('acme@in.example.com'), 'x-basalt-signature': '' })).rejects.toMatchObject({ status: 401 })
  })

  it('a custom driver: arbitrary and HTTP errors are classified for the hook', async () => {
    const hooks = new HookBus()
    const rejected = vi.fn()
    hooks.on('inbound-mail:rejected', rejected)
    const failing = (error: unknown): InboundMailDriver => ({
      name: 'custom',
      maxRequestBytes: 1024,
      receive: () => Promise.reject(error),
    })
    const { HttpError } = await import('@basaltkit/http')
    for (const [error, reason] of [
      [new Error('boom'), 'error'],
      [new HttpError(413, 'PAYLOAD_TOO_LARGE', 'x'), 'too-large'],
      [new HttpError(409, 'CONFLICT', 'x'), 'error'],
    ] as const) {
      const routes = inboundMailRoutes({ driver: failing(error), hooks, routes: [{ address: 'a@x.example', handler() {} }] })
      await expect(deliver(routes, message, {})).rejects.toBe(error)
      expect(rejected).toHaveBeenLastCalledWith({ reason, source: 'custom', digest: expect.any(String) })
    }
  })

  it('a custom driver works through the public contract', async () => {
    const mails: InboundMail[] = []
    const custom: InboundMailDriver = {
      name: 'test',
      maxRequestBytes: 2048,
      async receive({ body }) {
        return { raw: body.bytes, envelope: { from: '', to: 'a@x.example' }, source: 'test', receivedAt: new Date(), deliveryKey: 'k' }
      },
    }
    const routes = inboundMailRoutes({ driver: custom, routes: [{ address: 'a@x.example', handler: (ctx) => void mails.push(ctx.mail) }] })
    expect((await deliver(routes, message, {})).status).toBe(200)
    expect(mails[0]!.source).toBe('test')
  })
})
