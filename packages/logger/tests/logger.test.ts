import { describe, expect, it } from 'vitest'
import { runWithContext } from '@machize/core'
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
  it('emite JSON estruturado com level e mensagem', () => {
    const { lines, stream } = capture()
    createLogger({ destination: stream }).info({ pkg: 'core' }, 'boot ok')
    expect(lines[0]).toMatchObject({ msg: 'boot ok', pkg: 'core' })
  })

  it('enriquece com requestId/tenantId/userId do contexto ALS automaticamente', () => {
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

  it('redige campos sensíveis por padrão', () => {
    const { lines, stream } = capture()
    createLogger({ destination: stream }).info(
      { email: 'a@b.c', password: '123', auth: { token: 'jwt' } },
      'login',
    )
    expect(lines[0]?.['password']).toBe('[REDACTED]')
    expect((lines[0]?.['auth'] as { token: string }).token).toBe('[REDACTED]')
    expect(lines[0]?.['email']).toBe('a@b.c')
  })

  it('child logger mantém bindings e contexto', () => {
    const { lines, stream } = capture()
    const child = createLogger({ destination: stream }).child({ pkg: 'subscriptions' })
    runWithContext({ requestId: 'req-2' }, () => child.warn('quota baixa'))
    expect(lines[0]).toMatchObject({ pkg: 'subscriptions', requestId: 'req-2' })
  })

  it('respeita o level configurado', () => {
    const { lines, stream } = capture()
    const logger = createLogger({ destination: stream, level: 'warn' })
    logger.info('não aparece')
    logger.warn('aparece')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ msg: 'aparece' })
  })
})
