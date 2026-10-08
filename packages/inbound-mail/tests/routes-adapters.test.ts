import { request as httpRequest } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serve } from '@hono/node-server'
import { createApp } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin } from '@basaltkit/fastify'
import { EXPRESS, expressPlugin } from '@basaltkit/express'
import { HONO, honoPlugin } from '@basaltkit/hono'
import type { BasaltRoute } from '@basaltkit/http'
import { inboundMailRoutes, signedDriver, signInboundMail, type InboundMailContext } from '../src/index.js'

/**
 * Adapter parity: the same `inboundMailRoutes()` on Fastify, Express and Hono
 * must see byte-identical bodies and give identical answers.
 */
const SECRET = 'whsec_inbound_adapter_secret_000001'
const CAP = 64 * 1024

// 8-bit Latin-1 MIME: not valid UTF-8, so any decode/re-encode breaks the signature.
const raw = Buffer.concat([
  Buffer.from('From: a@example.org\r\nTo: acme@in.example.com\r\nSubject: caf', 'latin1'),
  Buffer.from([0xe9]),
  Buffer.from('\r\nContent-Type: text/plain; charset=ISO-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\nPre\xe7o \xff\xfe\r\n', 'latin1'),
])

type Seen = { to: string; raw: Buffer; oversize?: number; tenant?: string }

function buildRoutes(seen: Seen[]): BasaltRoute[] {
  return inboundMailRoutes({
    driver: signedDriver({ secret: SECRET, maxRequestBytes: CAP }),
    parse: { maxRawBytes: 1024 },
    routes: [
      {
        address: 'boom@in.example.com',
        handler() {
          throw new Error('handler failed')
        },
      },
      {
        address: 'parse@in.example.com',
        async handler(ctx: InboundMailContext) {
          await ctx.parse()
        },
      },
      {
        address: '{tenant}@in.example.com',
        handler(ctx: InboundMailContext) {
          const entry: Seen = { to: ctx.mail.envelope.to, raw: Buffer.from(ctx.mail.raw), tenant: ctx.match.params['tenant']! }
          if (ctx.mail.oversize !== undefined) entry.oversize = ctx.mail.oversize
          seen.push(entry)
        },
      },
    ],
  })
}

type Live = { base: URL; seen: Seen[]; close: () => Promise<void> }

const adapters: Record<string, () => Promise<Live>> = {
  fastify: async () => {
    const seen: Seen[] = []
    const app = await createApp({ plugins: [fastifyPlugin({ routes: buildRoutes(seen) })] }).boot()
    const server = app.container.get(FASTIFY)
    await server.listen({ port: 0, host: '127.0.0.1' })
    const address = server.server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    return { base: new URL(`http://127.0.0.1:${port}`), seen, close: () => app.shutdown() }
  },
  express: async () => {
    const seen: Seen[] = []
    const app = await createApp({ plugins: [expressPlugin({ routes: buildRoutes(seen) })] }).boot()
    const server = app.container.get(EXPRESS).listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    return {
      base: new URL(`http://127.0.0.1:${port}`),
      seen,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }
  },
  hono: async () => {
    const seen: Seen[] = []
    const app = await createApp({ plugins: [honoPlugin({ routes: buildRoutes(seen) })] }).boot()
    const { server, port } = await new Promise<{ server: { close: (cb: () => void) => void }; port: number }>((resolve) => {
      const instance = serve({ fetch: app.container.get(HONO).fetch, port: 0, hostname: '127.0.0.1' }, (info) =>
        resolve({ server: instance as unknown as { close: (cb: () => void) => void }, port: info.port }),
      )
    })
    return {
      base: new URL(`http://127.0.0.1:${port}`),
      seen,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }
  },
}

/** A raw POST through node:http, so the test controls Content-Length vs chunked exactly. */
function post(base: URL, headers: Record<string, string>, body: Buffer, chunked = false): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: base.hostname, port: base.port, path: '/inbound/mail', method: 'POST', headers: chunked ? headers : { ...headers, 'content-length': String(body.length) } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    // A server that refuses early may reset the socket mid-upload; the status already arrived.
    req.on('error', reject)
    if (chunked) {
      const half = Math.floor(body.length / 2)
      req.write(body.subarray(0, half))
      req.end(body.subarray(half))
    } else {
      req.end(body)
    }
  })
}

const signed = (to: string, bytes: Buffer = raw) => signInboundMail(bytes, { from: 'sender@example.org', to }, SECRET)

for (const [name, start] of Object.entries(adapters)) {
  describe(`inboundMailRoutes on ${name}`, () => {
    let live: Live
    beforeAll(async () => {
      live = await start()
    })
    afterAll(async () => {
      await live.close()
    })

    it('verifies byte-identical non-UTF-8 MIME and hands the exact bytes to the handler', async () => {
      const response = await post(live.base, signed('Acme@in.example.com'), raw)
      expect(response).toEqual({ status: 200, text: JSON.stringify({ accepted: true }) })
      const last = live.seen.at(-1)!
      expect(last.to).toBe('acme@in.example.com')
      expect(last.tenant).toBe('acme')
      expect(last.raw.equals(raw)).toBe(true)
    })

    it('a tampered byte is a 401', async () => {
      const tampered = Buffer.from(raw)
      tampered.writeUInt8(tampered.readUInt8(tampered.length - 3) ^ 1, tampered.length - 3)
      const response = await post(live.base, signed('acme@in.example.com'), tampered)
      expect(response.status).toBe(401)
      expect(response.text).toContain('INBOUND_MAIL_UNAUTHORIZED')
    })

    it('a tampered envelope header is a 401', async () => {
      const response = await post(live.base, { ...signed('acme@in.example.com'), 'x-basalt-mail-to': 'globex@in.example.com' }, raw)
      expect(response.status).toBe(401)
    })

    it('over the cap is a 413, with Content-Length and chunked', async () => {
      const big = Buffer.alloc(CAP + 1, 0x61)
      const headers = signed('acme@in.example.com', big)
      expect((await post(live.base, headers, big)).status).toBe(413)
      expect((await post(live.base, headers, big, true)).status).toBe(413)
    })

    it('accepts message/rfc822 with parameters and a chunked body', async () => {
      const headers = { ...signed('acme@in.example.com'), 'content-type': 'message/rfc822; charset=utf-8' }
      expect((await post(live.base, headers, raw, true)).status).toBe(200)
      expect(live.seen.at(-1)!.raw.equals(raw)).toBe(true)
    })

    it('text/plain is a 415', async () => {
      const response = await post(live.base, { ...signed('acme@in.example.com'), 'content-type': 'text/plain' }, raw)
      expect(response.status).toBe(415)
      expect(response.text).toContain('INBOUND_MAIL_UNSUPPORTED_TYPE')
    })

    it('unrouted and routed deliveries get identical answers', async () => {
      const routed = await post(live.base, signed('acme@in.example.com'), raw)
      const unrouted = await post(live.base, signed('someone@elsewhere.example'), raw)
      const badCapture = await post(live.base, signed('a.b@in.example.com'), raw)
      expect(unrouted).toEqual(routed)
      expect(badCapture).toEqual(routed)
    })

    it('a handler throw is a sanitised 500', async () => {
      const response = await post(live.base, signed('boom@in.example.com'), raw)
      expect(response.status).toBe(500)
      expect(response.text).not.toContain('handler failed')
    })

    it('a parse limit is a 422', async () => {
      const big = Buffer.concat([raw, Buffer.alloc(2048, 0x61)])
      const response = await post(live.base, signed('parse@in.example.com', big), big)
      expect(response.status).toBe(422)
      expect(response.text).toContain('INBOUND_MAIL_LIMIT')
    })

    it('an oversize notice is delivered to the handler', async () => {
      const empty = Buffer.alloc(0)
      const headers = signInboundMail(empty, { from: 'sender@example.org', to: 'acme@in.example.com' }, SECRET, { oversize: 26_000_000 })
      expect((await post(live.base, headers, empty)).status).toBe(200)
      expect(live.seen.at(-1)).toMatchObject({ oversize: 26_000_000 })
      expect(live.seen.at(-1)!.raw.length).toBe(0)
    })
  })
}
