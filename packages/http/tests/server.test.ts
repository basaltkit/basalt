import { describe, expect, it } from 'vitest'
import { HttpServerCollector, healthPlugin } from '../src/index.js'
import { FakeReply, bootWith, makeRequest } from './support.js'

describe('HttpServerCollector', () => {
  it('collects pre-hooks, after-hooks and extra routes', () => {
    const c = new HttpServerCollector()
    c.use(() => {})
    c.after(() => {})
    c.addRoute('GET', '/x', () => ({ ok: true }))
    expect(c.preHooks).toHaveLength(1)
    expect(c.afterHooks).toHaveLength(1)
    expect(c.extraRoutes[0]).toMatchObject({ method: 'GET', url: '/x' })
  })

  it('runPre runs hooks in order and short-circuits once one sends', async () => {
    const c = new HttpServerCollector()
    const order: number[] = []
    c.use(() => {
      order.push(1)
    })
    c.use(({ reply }) => {
      order.push(2)
      reply.code(204).send()
    })
    c.use(() => {
      order.push(3)
    })

    const reply = new FakeReply()
    const sent = await c.runPre(makeRequest(), reply)
    expect(sent).toBe(true)
    expect(order).toEqual([1, 2]) // third hook skipped
  })

  it('runPre returns false when no hook sends', async () => {
    const c = new HttpServerCollector()
    c.use(({ reply }) => {
      reply.header('x-test', '1')
    })
    const reply = new FakeReply()
    expect(await c.runPre(makeRequest(), reply)).toBe(false)
    expect(reply.headers['x-test']).toBe('1')
  })

  it('runAfter passes status and duration to every after-hook', async () => {
    const c = new HttpServerCollector()
    let seen: { statusCode: number; durationMs: number } | undefined
    c.after((info) => {
      seen = { statusCode: info.statusCode, durationMs: info.durationMs }
    })
    await c.runAfter(makeRequest(), new FakeReply(), 201, 12)
    expect(seen).toEqual({ statusCode: 201, durationMs: 12 })
  })
})

describe('healthPlugin (neutral, via collector)', () => {
  it('registers /livez and /readyz; readyz is 503 when a check fails', async () => {
    const c = new HttpServerCollector()
    await bootWith(c, [
      healthPlugin({
        checks: {
          up: () => ({ ok: true }),
          down: () => ({ ok: false, detail: 'unreachable' }),
        },
      }),
    ])
    const routes = Object.fromEntries(c.extraRoutes.map((r) => [r.url, r]))
    expect(routes['/livez']).toBeTruthy()
    expect(routes['/readyz']).toBeTruthy()

    expect(await routes['/livez']!.handler({ request: makeRequest(), reply: new FakeReply() })).toMatchObject({
      status: 'ok',
    })

    const reply = new FakeReply()
    await routes['/readyz']!.handler({ request: makeRequest(), reply })
    expect(reply.statusCode).toBe(503)
    expect((reply.payload as { checks: Record<string, { ok: boolean }> }).checks['down']?.ok).toBe(false)
  })

  it('readyz is 200 when all checks pass', async () => {
    const c = new HttpServerCollector()
    await bootWith(c, [healthPlugin({ checks: { up: () => ({ ok: true }) } })])
    const readyz = c.extraRoutes.find((r) => r.url === '/readyz')!
    const reply = new FakeReply()
    const body = await readyz.handler({ request: makeRequest(), reply })
    expect(reply.sent).toBe(false) // handler returns the body, doesn't set 503
    expect(body).toMatchObject({ status: 'ok' })
  })
})
