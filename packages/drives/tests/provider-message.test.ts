import { describe, expect, it } from 'vitest'
import { serve } from '@hono/node-server'
import { createApp } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin } from '@basaltkit/fastify'
import { EXPRESS, expressPlugin } from '@basaltkit/express'
import { HONO, honoPlugin } from '@basaltkit/hono'
import { internalDetailsOf, route, toErrorResponse, type HttpErrorReport } from '@basaltkit/http'
import {
  DriveAccessDeniedError,
  DriveCredentialsInvalidError,
  DriveProviderError,
  providerMessageOf,
} from '../src/errors.js'

const SECRET_HINT = 'does not have the required scope files.metadata.read'

describe('providerMessageOf', () => {
  it('strips control and bidi characters and collapses whitespace', () => {
    expect(providerMessageOf('line one\n\u0007line‮ two\t\t end')).toBe('line one line two end')
  })

  it('redacts URLs, bearer credentials, JWTs and long opaque tokens', () => {
    const out = providerMessageOf(
      'GET https://graph.microsoft.com/v1.0/x?tempauth=abc failed; Authorization: Bearer sl.ABCDEF123; ' +
        'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig and token ' +
        'a'.repeat(48),
    )!
    expect(out).not.toContain('https://')
    expect(out).not.toContain('tempauth')
    expect(out).not.toContain('sl.ABCDEF123')
    expect(out).not.toContain('eyJhbGci')
    expect(out).not.toContain('a'.repeat(48))
    expect(out).toContain('[url]')
    expect(out).toContain('Bearer [redacted]')
  })

  it('truncates to the cap and returns undefined for nothing usable', () => {
    const out = providerMessageOf('word '.repeat(400), 100)!
    expect(out.length).toBe(100)
    expect(out.endsWith('…')).toBe(true)
    expect(providerMessageOf('   \u0000  ')).toBeUndefined()
    expect(providerMessageOf(42)).toBeUndefined()
  })
})

describe('provider message on the log-only channel', () => {
  const errors = [
    new DriveProviderError('dropbox', 'http_400', 400, false, { providerMessage: SECRET_HINT }),
    new DriveAccessDeniedError('google', 'insufficientPermissions', { providerMessage: SECRET_HINT }),
    new DriveCredentialsInvalidError('conn-1', 'the provider answered 401 (x).', { providerMessage: SECRET_HINT }),
  ]

  it.each(errors.map((e) => [e.code, e] as const))('%s keeps it out of message, details and JSON', (_code, error) => {
    expect(error.message).not.toContain(SECRET_HINT)
    expect(JSON.stringify(error.details)).not.toContain(SECRET_HINT)
    expect(JSON.stringify(error)).not.toContain(SECRET_HINT)
    expect(Object.keys(error)).not.toContain('internalDetails')
    expect(internalDetailsOf(error)).toEqual({ providerMessage: SECRET_HINT })
    expect(JSON.stringify(toErrorResponse(error))).not.toContain(SECRET_HINT)
  })

  it('attaches nothing when no message was supplied', () => {
    expect(internalDetailsOf(new DriveProviderError('dropbox', 'http_400', 400))).toBeUndefined()
  })
})

/**
 * Adapter parity: the provider message must reach the error reporter and never
 * the response body, identically on Fastify, Express and Hono.
 */
describe('provider message across adapters', () => {
  const routes = [
    route({
      method: 'GET',
      url: '/boom',
      handler() {
        throw new DriveProviderError('dropbox', 'http_400', 400, false, { providerMessage: SECRET_HINT })
      },
    }),
  ]

  type Live = { url: string; reports: HttpErrorReport[]; close: () => Promise<void> }

  const adapters: Record<string, () => Promise<Live>> = {
    fastify: async () => {
      const reports: HttpErrorReport[] = []
      const app = await createApp({ plugins: [fastifyPlugin({ routes, onError: (r) => void reports.push(r) })] }).boot()
      const server = app.container.get(FASTIFY)
      await server.listen({ port: 0, host: '127.0.0.1' })
      const address = server.server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      return { url: `http://127.0.0.1:${port}`, reports, close: () => app.shutdown() }
    },
    express: async () => {
      const reports: HttpErrorReport[] = []
      const app = await createApp({ plugins: [expressPlugin({ routes, onError: (r) => void reports.push(r) })] }).boot()
      const server = app.container.get(EXPRESS).listen(0, '127.0.0.1')
      await new Promise<void>((resolve) => server.once('listening', () => resolve()))
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      return {
        url: `http://127.0.0.1:${port}`,
        reports,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
      }
    },
    hono: async () => {
      const reports: HttpErrorReport[] = []
      const app = await createApp({ plugins: [honoPlugin({ routes, onError: (r) => void reports.push(r) })] }).boot()
      const { server, port } = await new Promise<{ server: { close: (cb: () => void) => void }; port: number }>(
        (resolve) => {
          const instance = serve({ fetch: app.container.get(HONO).fetch, port: 0, hostname: '127.0.0.1' }, (info) =>
            resolve({ server: instance as unknown as { close: (cb: () => void) => void }, port: info.port }),
          )
        },
      )
      return {
        url: `http://127.0.0.1:${port}`,
        reports,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
      }
    },
  }

  for (const [name, start] of Object.entries(adapters)) {
    it(`${name}: reported to onError, absent from the response`, async () => {
      const live = await start()
      try {
        const response = await fetch(`${live.url}/boom`)
        const text = await response.text()
        expect(response.status).toBe(502)
        expect(text).toContain('DRIVE_PROVIDER_ERROR')
        expect(text).not.toContain(SECRET_HINT)
        expect(live.reports).toHaveLength(1)
        expect(internalDetailsOf(live.reports[0]!.error)).toEqual({ providerMessage: SECRET_HINT })
      } finally {
        await live.close()
      }
    })
  }
})
