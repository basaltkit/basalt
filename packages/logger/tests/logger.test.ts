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
