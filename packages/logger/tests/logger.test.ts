import { describe, expect, it } from 'vitest'
import { runWithContext } from '@basaltkit/core'
import { createLogger } from '../src/index.js'

function capture() {
  const lines: Record<string, unknown>[] = []
  return {
    lines,
    stream: {
      write(msg: string) {
        lines.push(JSON.parse(msg))
      },
    },
  }
}

describe('createLogger', () => {
  it('emits structured JSON with level and message', () => {
    const { lines, stream } = capture()
    createLogger({ destination: stream }).info({ pkg: 'core' }, 'boot ok')
    expect(lines[0]).toMatchObject({ msg: 'boot ok', pkg: 'core' })
  })

  it('automatically enriches with requestId/tenantId/userId from the ALS context', () => {
    const { lines, stream } = capture()
    const logger = createLogger({ destination: stream })

    runWithContext(
      { requestId: 'req-1', tenant: { id: 't-acme' }, user: { id: 'u-9' } },
      () => logger.info('dentro do request'),
    )
    logger.info('fora do request')

    expect(lines[0]).toMatchObject({ requestId: 'req-1', tenantId: 't-acme', userId: 'u-9' })
    expect(lines[1]?.['requestId']).toBeUndefined()
  })

  it('redacts sensitive fields by default', () => {
    const { lines, stream } = capture()
    createLogger({ destination: stream }).info(
      { email: 'a@b.c', password: '123', auth: { token: 'jwt' } },
      'login',
    )
    expect(lines[0]?.['password']).toBe('[REDACTED]')
    expect((lines[0]?.['auth'] as { token: string }).token).toBe('[REDACTED]')
    expect(lines[0]?.['email']).toBe('a@b.c')
  })

  it('redacts modern token/cookie names top-level and one level deep (PII F1)', () => {
    const { lines, stream } = capture()
    createLogger({ destination: stream }).info(
      {
        accessToken: 'a',
        refreshToken: 'b',
        body: { accessToken: 'c', mfaCode: '123456' },
        headers: { authorization: 'Bearer x', cookie: 'sid=1' },
      },
      'auth',
    )
    const l = lines[0] as Record<string, Record<string, unknown>>
    expect(l['accessToken']).toBe('[REDACTED]')
    expect(l['refreshToken']).toBe('[REDACTED]')
    expect(l['body']?.['accessToken']).toBe('[REDACTED]')
    expect(l['body']?.['mfaCode']).toBe('[REDACTED]')
    expect(l['headers']?.['authorization']).toBe('[REDACTED]')
    expect(l['headers']?.['cookie']).toBe('[REDACTED]')
  })

  describe('secure-by-default redaction (no secret reaches the log at any depth)', () => {
    const R = '[REDACTED]'

    it('redacts API-key headers and response set-cookie in logged header bags', () => {
      const { lines, stream } = capture()
      createLogger({ destination: stream }).info(
        {
          headers: { 'x-api-key': 'live_key_1', 'X-Api-Key': 'live_key_2', accept: 'json' },
          req: { headers: { 'x-api-key': 'live_key_3', 'proxy-authorization': 'Basic x' } },
          res: { headers: { 'set-cookie': ['sid=abc; HttpOnly'] } },
        },
        'request',
      )
      const out = JSON.stringify(lines[0])
      expect(out).not.toContain('live_key')
      expect(out).not.toContain('sid=abc')
      expect(out).not.toContain('Basic x')
      expect((lines[0]?.['headers'] as Record<string, unknown>)['accept']).toBe('json')
    })

    it('redacts snake_case OAuth tokens and stored-credential field names', () => {
      const { lines, stream } = capture()
      createLogger({ destination: stream }).info(
        {
          access_token: 'at',
          refresh_token: 'rt',
          id_token: 'it',
          client_secret: 'cs',
          clientSecret: 'cs2',
          passwordHash: 'ph',
          mfaSecret: 'ms',
          privateKey: 'pk',
          private_key: 'pk2',
          webhookSecret: 'ws',
          APP_SECRET: 'as',
          userId: 'u-1',
        },
        'oauth',
      )
      const l = lines[0] as Record<string, unknown>
      for (const k of [
        'access_token', 'refresh_token', 'id_token', 'client_secret', 'clientSecret',
        'passwordHash', 'mfaSecret', 'privateKey', 'private_key', 'webhookSecret', 'APP_SECRET',
      ]) {
        expect(l[k], k).toBe(R)
      }
      expect(l['userId']).toBe('u-1')
    })

    it('redacts secrets nested two or more levels deep and inside arrays', () => {
      const { lines, stream } = capture()
      const input = {
        user: { profile: { credentials: { password: 'deep-pw' } } },
        items: [{ apiKey: 'arr-key' }, { nested: [{ token: 'arr-token' }] }],
        oauth: { response: { body: { access_token: 'deep-at' } } },
      }
      createLogger({ destination: stream }).info(input, 'deep')
      const out = JSON.stringify(lines[0])
      expect(out).not.toContain('deep-pw')
      expect(out).not.toContain('arr-key')
      expect(out).not.toContain('arr-token')
      expect(out).not.toContain('deep-at')
      // The caller's object is never mutated.
      expect(input.user.profile.credentials.password).toBe('deep-pw')
      expect(input.items[0]).toEqual({ apiKey: 'arr-key' })
    })

    it('redacts secret-bearing properties on logged errors and child bindings', () => {
      const { lines, stream } = capture()
      const err = Object.assign(new Error('upstream failed'), {
        config: { headers: { Authorization: 'Bearer err-secret' } },
      })
      const child = createLogger({ destination: stream }).child({ apiKey: 'bind-key', svc: 'x' })
      child.error({ err }, 'boom')
      const out = JSON.stringify(lines[0])
      expect(out).not.toContain('err-secret')
      expect(out).not.toContain('bind-key')
      expect(out).toContain('upstream failed')
      expect(lines[0]?.['svc']).toBe('x')
    })

    it('does not leak through circular references', () => {
      const { lines, stream } = capture()
      const a: Record<string, unknown> = { name: 'a' }
      a['self'] = a
      a['inner'] = { secret: 'circ-secret', back: a }
      createLogger({ destination: stream }).info({ a }, 'circ')
      expect(JSON.stringify(lines[0])).not.toContain('circ-secret')
    })

    it('matches secret names case- and separator-insensitively and censors beyond the depth limit', () => {
      const { lines, stream } = capture()
      let deep: Record<string, unknown> = { value: 'too-deep-value' }
      for (let i = 0; i < 20; i++) deep = { next: deep }
      createLogger({ destination: stream }).info(
        { 'Access-Token': 'v1', 'X-API-KEY': 'v2', SESSION_TOKEN: 'v3', 'Proxy-Authorization': 'v4', deep },
        'variants',
      )
      const out = JSON.stringify(lines[0])
      for (const v of ['v1', 'v2', 'v3', 'v4', 'too-deep-value']) expect(out).not.toContain(`"${v}"`)
    })

    it('keeps non-secret fields, dates and user-supplied redact paths intact', () => {
      const { lines, stream } = capture()
      const at = new Date('2026-01-01T00:00:00.000Z')
      createLogger({ destination: stream, redact: ['customer.iban'] }).info(
        {
          tokenCount: 3,
          passwordPolicy: 'strong',
          bypass: true,
          at,
          customer: { iban: 'AO06...', name: 'Ana' },
          list: [1, 'two', null],
        },
        'safe',
      )
      expect(lines[0]).toMatchObject({
        tokenCount: 3,
        passwordPolicy: 'strong',
        bypass: true,
        at: '2026-01-01T00:00:00.000Z',
        customer: { iban: '[REDACTED]', name: 'Ana' },
        list: [1, 'two', null],
      })
    })

    it('redacts secrets held by class instances and toJSON carriers (axios-style headers)', () => {
      const { lines, stream } = capture()
      // Mirrors axios' AxiosHeaders: a class instance with toJSON(), stored on
      // `error.config.headers` of every failed HTTP call.
      class HeaderBag {
        constructor(init: Record<string, string>) {
          Object.assign(this, init)
        }
        toJSON(): Record<string, unknown> {
          return { ...(this as object) }
        }
      }
      class Creds {
        apiKey = 'cls-key'
        nested = { token: 'cls-token' }
      }
      const err = Object.assign(new Error('Request failed with status code 500'), {
        config: { url: 'https://api.example', headers: new HeaderBag({ Authorization: 'Bearer axios-secret' }) },
      })
      const log = createLogger({ destination: stream })
      log.error({ err }, 'upstream')
      log.info({ headers: new HeaderBag({ Authorization: 'Bearer top-secret', Accept: 'json' }) }, 'bag')
      log.info({ ctx: { creds: new Creds() } }, 'instance')
      const out = lines.map((l) => JSON.stringify(l)).join('\n')
      for (const v of ['axios-secret', 'top-secret', 'cls-key', 'cls-token']) expect(out, v).not.toContain(v)
      expect((lines[0]?.['err'] as Record<string, unknown>)['config']).toMatchObject({ url: 'https://api.example' })
      expect(lines[1]?.['headers']).toMatchObject({ Accept: 'json' })
    })

    it('redacts secrets on nested and aggregated errors and keeps the error type', () => {
      const { lines, stream } = capture()
      const inner = Object.assign(new Error('db down'), { connection: { password: 'agg-pw' } })
      const upstream = Object.assign(new TypeError('inner'), { meta: { apiKey: 'nested-err-key' } })
      const log = createLogger({ destination: stream })
      log.error({ err: new AggregateError([inner], 'multi') }, 'agg')
      log.error(Object.assign(new RangeError('outer'), { upstream }))
      const out = lines.map((l) => JSON.stringify(l)).join('\n')
      expect(out).not.toContain('agg-pw')
      expect(out).not.toContain('nested-err-key')
      expect(out).toContain('db down')
      expect((lines[0]?.['err'] as Record<string, unknown>)['type']).toBe('AggregateError')
      expect((lines[1]?.['err'] as Record<string, unknown>)['type']).toBe('RangeError')
    })

    it('redacts framework-minted secrets with key-shaped and plural names', () => {
      const { lines, stream } = capture()
      createLogger({ destination: stream }).info(
        {
          tokens: { access: 'p1', refresh: 'p2' },
          apiKeys: ['p3'],
          passwords: ['p4'],
          secretKey: 'p5',
          stripe_secret_key: 'p6',
          signingKey: 'p7',
          mfaEncryptionKey: 'p8',
          recoveryCodes: ['p9'],
          backup_codes: ['p10'],
          credential: 'p11',
          sessionId: 'p12',
          inputTokens: 42,
          publicKey: 'pub',
        },
        'plural',
      )
      const l = lines[0] as Record<string, unknown>
      for (const k of [
        'tokens', 'apiKeys', 'passwords', 'secretKey', 'stripe_secret_key', 'signingKey',
        'mfaEncryptionKey', 'recoveryCodes', 'backup_codes', 'credential', 'sessionId',
      ]) {
        expect(l[k], k).toBe(R)
      }
      expect(l['inputTokens']).toBe(42)
      expect(l['publicKey']).toBe('pub')
    })

    it('bounds the work on large shared object graphs and leaves req/res instances to serializers', () => {
      const { lines, stream } = capture()
      // A DAG where every node is reachable through ten paths: without a node
      // budget the walk would visit 10^10 paths.
      let node: Record<string, unknown> = { secret: 'dag-secret' }
      for (let i = 0; i < 12; i++) {
        const next: Record<string, unknown> = {}
        for (let j = 0; j < 10; j++) next[`k${j}`] = node
        node = next
      }
      class FastifyLikeRequest {
        get method(): string {
          return 'GET'
        }
      }
      const req = new FastifyLikeRequest()
      const log = createLogger({ destination: stream }).child(
        {},
        { serializers: { req: (r: FastifyLikeRequest) => ({ method: r.method }) } },
      )
      const started = Date.now()
      log.info({ graph: node, req }, 'dag')
      expect(Date.now() - started).toBeLessThan(2000)
      expect(JSON.stringify(lines[0])).not.toContain('dag-secret')
      expect(lines[0]?.['req']).toEqual({ method: 'GET' })
    })
  })

  it('child logger keeps bindings and context', () => {
    const { lines, stream } = capture()
    const child = createLogger({ destination: stream }).child({ pkg: 'subscriptions' })
    runWithContext({ requestId: 'req-2' }, () => child.warn('quota baixa'))
    expect(lines[0]).toMatchObject({ pkg: 'subscriptions', requestId: 'req-2' })
  })

  it('honors the configured level', () => {
    const { lines, stream } = capture()
    const logger = createLogger({ destination: stream, level: 'warn' })
    logger.info('não aparece')
    logger.warn('aparece')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ msg: 'aparece' })
  })
})
