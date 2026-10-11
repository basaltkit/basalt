import { describe, expect, it, vi } from 'vitest'
import { Container, ctx } from '@basaltkit/core'
import {
  RequestDisposers,
  route,
  runRoute,
  type HttpReply,
  type HttpRequest,
  type RequestDisposer,
  type RequestEnricher,
} from '../src/index.js'

const reply = (): HttpReply => {
  let status = 200
  let sent = false
  const self = {
    get sent() {
      return sent
    },
    get statusCode() {
      return status
    },
    raw: null,
    code(next: number) {
      status = next
      return self
    },
    header() {
      return self
    },
    send() {
      sent = true
      return self
    },
  }
  return self as unknown as HttpReply
}

const request = (): HttpRequest => ({
  method: 'GET',
  url: '/',
  headers: {},
  params: {},
  query: {},
  body: undefined,
  raw: null,
})

describe('RequestDisposers (BK-077)', () => {
  it('runs every disposer once, last-registered first', async () => {
    const order: string[] = []
    const disposers = new RequestDisposers()
    disposers.add(() => void order.push('first'))
    disposers.add(async () => void order.push('second'))
    await Promise.all([disposers.run(), disposers.run()])
    await disposers.run()
    expect(order).toEqual(['second', 'first'])
    expect(disposers.ran).toBe(true)
  })

  it('runs a disposer added after the request ended at once', async () => {
    const order: string[] = []
    const disposers = new RequestDisposers()
    await disposers.run()
    disposers.add(() => void order.push('late'))
    await Promise.resolve()
    expect(order).toEqual(['late'])
  })

  it('reports a failing disposer and still runs the others', async () => {
    const errors: unknown[] = []
    const order: string[] = []
    const disposers = new RequestDisposers((error) => errors.push(error))
    disposers.add(() => void order.push('kept'))
    disposers.add(() => {
      throw new Error('release failed')
    })
    await disposers.run()
    expect(order).toEqual(['kept'])
    expect(errors).toHaveLength(1)
  })
})

describe('runRoute disposers (BK-077)', () => {
  const enricherReturning =
    (log: string[], name: string): RequestEnricher =>
    () =>
    () =>
      void log.push(name)

  it('hands disposers to the caller sink when one is given, and does not run them itself', async () => {
    const log: string[] = []
    const sunk: RequestDisposer[] = []
    const def = route({ method: 'GET', url: '/', handler: () => ({ ok: true }) })
    await runRoute(def, request(), reply(), {
      container: new Container(),
      enrichers: [enricherReturning(log, 'a'), () => undefined],
      onDispose: (disposer) => sunk.push(disposer),
    })
    expect(sunk).toHaveLength(1)
    expect(log).toEqual([])
  })

  it('runs them itself when there is no sink — after the handler, and when it throws', async () => {
    const log: string[] = []
    const ok = route({
      method: 'GET',
      url: '/',
      handler: () => {
        log.push('handler')
        return { ok: true }
      },
    })
    await runRoute(ok, request(), reply(), {
      container: new Container(),
      enrichers: [enricherReturning(log, 'a'), enricherReturning(log, 'b')],
    })
    expect(log).toEqual(['handler', 'b', 'a'])

    log.length = 0
    const failing = route({
      method: 'GET',
      url: '/',
      handler: () => {
        throw new Error('boom')
      },
    })
    await expect(
      runRoute(failing, request(), reply(), {
        container: new Container(),
        enrichers: [enricherReturning(log, 'a')],
      }),
    ).rejects.toThrow('boom')
    expect(log).toEqual(['a'])
  })

  it('still runs the disposers of earlier enrichers when a later one rejects', async () => {
    const log: string[] = []
    const def = route({ method: 'GET', url: '/', handler: () => ({ ok: true }) })
    await expect(
      runRoute(def, request(), reply(), {
        container: new Container(),
        enrichers: [
          enricherReturning(log, 'a'),
          () => {
            throw new Error('no tenant')
          },
        ],
      }),
    ).rejects.toThrow('no tenant')
    expect(log).toEqual(['a'])
  })

  it('exposes the sink as ctx().onDispose, request context only, not copied by a spread', async () => {
    const sunk: RequestDisposer[] = []
    let copied: unknown = 'unset'
    const def = route({
      method: 'GET',
      url: '/',
      handler: () => {
        const context = ctx()
        context.onDispose?.(() => undefined)
        if (false as boolean) {
          // @ts-expect-error onDispose is read-only
          context.onDispose = () => {}
        }
        copied = { ...context }.onDispose
        return { enumerable: Object.keys(context).includes('onDispose') }
      },
    })
    const result = await runRoute(def, request(), reply(), {
      container: new Container(),
      onDispose: (disposer) => sunk.push(disposer),
    })
    expect(sunk).toHaveLength(1)
    expect(result).toEqual({ enumerable: false })
    expect(copied).toBeUndefined()
  })

  it('reports a failing disposer on the console when the caller passes no sink, and still runs the others', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const ran: string[] = []
      const def = route({ method: 'GET', url: '/', handler: () => ({ ok: true }) })
      const result = await runRoute(def, request(), reply(), {
        container: new Container(),
        enrichers: [
          () => () => {
            ran.push('sibling')
          },
          () => () => {
            throw new Error('release failed')
          },
        ],
      })
      expect(result).toEqual({ ok: true })
      expect(ran).toEqual(['sibling'])
      expect(error).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(error.mock.calls[0]?.[1])).toContain('REQUEST_DISPOSER_FAILED')
    } finally {
      error.mockRestore()
    }
  })

  it('reports a late ctx().onDispose disposer that fails after the route settled', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      let late: ((disposer: RequestDisposer) => void) | undefined
      const def = route({
        method: 'GET',
        url: '/',
        handler: () => {
          late = ctx().onDispose
          return 'ok'
        },
      })
      await runRoute(def, request(), reply(), { container: new Container() })
      expect(late).toBeTypeOf('function')
      late!(() => {
        throw new Error('late failure')
      })
      await new Promise((resolve) => setImmediate(resolve))
      expect(error).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(error.mock.calls[0]?.[1])).toContain('REQUEST_DISPOSER_FAILED')
    } finally {
      error.mockRestore()
    }
  })
})
