/**
 * `realtimeSse()` over `@basaltkit/http`'s `sse()` on every adapter (BK-079):
 * one hub event is one frame on the wire, a client disconnect unregisters the
 * connection, and a refused subscription ends the stream. Not a test file on
 * its own — each adapter package runs it against its own driver, the same way
 * it runs the HTTP parity matrix.
 */
import { route, sse } from '@basaltkit/http'
import { afterEach, describe, expect, it } from 'vitest'
import type { ParityDriver } from '../../http/tests/adapter-parity.js'
import { RealtimeHub, realtimeSse, type RealtimeHubOptions } from '../src/index.js'

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

async function until(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`)
    await settle()
  }
}

export function realtimeSseParitySuite(adapter: string, driver: ParityDriver): void {
  describe(`${adapter}: realtimeSse() over sse() parity (BK-079)`, () => {
    afterEach(() => driver.close())

    const boot = async (options: RealtimeHubOptions = {}) => {
      const hub = new RealtimeHub(undefined, options)
      await hub.start()
      let opened: () => void = () => {}
      const open = new Promise<void>((resolve) => {
        opened = resolve
      })
      const live = route({
        method: 'GET',
        url: '/live',
        handler: () =>
          sse(
            realtimeSse(hub, {
              meta: { tenantId: 'acme', userId: 'ana', id: 'conn-1' },
              channels: ['notes', 'private'],
              onOpen: () => opened(),
            }),
          ),
      })
      const send = await driver.boot([live], [])
      return { hub, send, open }
    }

    it('delivers one hub event as exactly one frame, then unregisters on disconnect', async () => {
      const { hub, send, open } = await boot()
      const abort = new AbortController()
      const res = await send.raw({ method: 'GET', url: '/live', signal: abort.signal })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/)
      await open
      expect(hub.count('acme', 'notes')).toBe(1)
      expect(hub.presence('acme', 'notes')).toEqual(['ana'])

      await hub.publish('acme', 'notes', 'created', { id: 1 })
      await hub.publish('globex', 'notes', 'created', { id: 2 }) // another tenant: never delivered

      const reader = res.body!.getReader()
      let text = ''
      while (!text.includes('\n\n')) {
        const { value, done } = await reader.read()
        if (done) break
        text += Buffer.from(value).toString('utf8')
      }
      expect(text).toBe('event: created\ndata: {"channel":"notes","data":{"id":1}}\n\n')

      abort.abort()
      await reader.cancel().catch(() => {})
      await until(() => hub.count('acme', 'notes') === 0, 'connection unregistered')
      expect(hub.presence('acme', 'notes')).toEqual([])
    })

    it('ends the stream when the hub refuses a channel', async () => {
      const { hub, send } = await boot({ authorize: (_connection, channel) => channel !== 'private' })
      const res = await send.raw({ method: 'GET', url: '/live' })
      expect(res.status).toBe(200)
      // The body ends: the refused subscription closed the stream.
      expect(await res.text()).toBe('')
      await until(() => hub.count('acme', 'notes') === 0, 'connection unregistered')
    })
  })
}
