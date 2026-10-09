/**
 * @basaltkit/mcp consumes @basaltkit/http through its public API only.
 *
 * The idempotency header comes from `idempotencyHeaderOf()`, never from http's
 * internal metadata bucket, so http can change how it stores the stage freely.
 * And a request disposer that fails during a tool call is reported through
 * `reportError` (code `REQUEST_DISPOSER_FAILED`), never dropped silently.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Container, ctx, ensureMetadata } from '@basaltkit/core'
import { route, type HttpErrorReport, type RequestEnricher } from '@basaltkit/http'

const helper = vi.hoisted(() => ({ header: undefined as string | undefined }))
vi.mock('@basaltkit/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@basaltkit/http')>()
  return { ...actual, idempotencyHeaderOf: () => helper.header }
})

const { collectTools } = await import('../src/index.js')

afterEach(() => {
  helper.header = undefined
  vi.restoreAllMocks()
})

const echo = route({
  method: 'POST',
  url: '/echo',
  meta: { mcp: { name: 'echo' } },
  handler: ({ request }) => ({ headers: request.headers }),
})

describe('idempotency header from the public helper', () => {
  it('strips the header idempotencyHeaderOf() reports, with no plugin and no metadata registered', async () => {
    // No idempotencyPlugin, so http's internal bucket is empty: only the
    // public helper (mocked here) can name `x-custom-key`.
    helper.header = 'x-custom-key'
    const [tool] = collectTools([echo], new Container(), {
      reportError: false,
      forwardHeaders: ['x-custom-key', 'idempotency-key', 'x-keep'],
    })
    const result = await tool!.invoke({}, { headers: { 'x-custom-key': 'k1', 'idempotency-key': 'k2', 'x-keep': 'yes' } })
    expect(result.structuredContent).toEqual({ headers: { 'x-keep': 'yes' } })
  })

  it("always drops the default 'idempotency-key', even when the helper reports nothing", async () => {
    const [tool] = collectTools([echo], new Container(), { reportError: false, forwardHeaders: ['idempotency-key', 'x-keep'] })
    const result = await tool!.invoke({}, { headers: { 'idempotency-key': 'k', 'x-keep': 'yes' } })
    expect(result.structuredContent).toEqual({ headers: { 'x-keep': 'yes' } })
  })

  it("never names http's internal idempotency metadata bucket in its source", () => {
    const dir = join(import.meta.dirname, '../src')
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
      expect(readFileSync(join(dir, file), 'utf8'), file).not.toContain('http:idempotency')
    }
  })
})

/** A container whose enricher (http's public enricher bucket) registers a disposer through ctx().onDispose. */
const withDisposer = (disposer: () => void | Promise<void>): Container => {
  const container = new Container()
  const enricher: RequestEnricher = () => {
    const dispose = ctx().onDispose
    if (dispose) dispose(disposer)
  }
  ensureMetadata(container).add('http:enrichers', enricher)
  return container
}

const ok = route({ method: 'GET', url: '/ok', meta: { mcp: { name: 'ok' } }, handler: () => ({ ok: true }) })

describe('request disposers during a tool call', () => {
  it('reports a failing disposer through reportError exactly once; the tool result is unaffected', async () => {
    const container = withDisposer(() => {
      throw new Error('lease release failed')
    })
    const reports: HttpErrorReport[] = []
    const [tool] = collectTools([ok], container, { reportError: (report) => reports.push(report) })
    const result = await tool!.invoke({})
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({ ok: true })
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ status: 500, code: 'REQUEST_DISPOSER_FAILED', method: 'GET', url: '/ok' })
  })

  it('with reportError: false nothing reaches console.error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const container = withDisposer(() => {
      throw new Error('lease release failed')
    })
    const [tool] = collectTools([ok], container, { reportError: false })
    const result = await tool!.invoke({})
    expect(result.structuredContent).toEqual({ ok: true })
    expect(error).not.toHaveBeenCalled()
  })

  it('on abort the tool answers cancelled now, and the disposer runs only after the handler settles', async () => {
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let disposed!: () => void
    const disposedP = new Promise<void>((resolve) => {
      disposed = resolve
    })
    const container = withDisposer(() => {
      order.push('dispose')
      disposed()
    })
    const slow = route({
      method: 'GET',
      url: '/slow',
      meta: { mcp: { name: 'slow' } },
      handler: async () => {
        await gate
        order.push('handler settled')
        return { ok: true }
      },
    })
    const [tool] = collectTools([slow], container, { reportError: false })
    const controller = new AbortController()
    const pending = tool!.invoke({}, { signal: controller.signal })
    await new Promise((resolve) => setImmediate(resolve))
    controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    order.push('cancelled')
    expect(order).toEqual(['cancelled'])
    release()
    await disposedP
    expect(order).toEqual(['cancelled', 'handler settled', 'dispose'])
  })
})
