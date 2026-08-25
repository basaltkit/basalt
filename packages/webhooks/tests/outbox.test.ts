import { describe, expect, it } from 'vitest'
import { createApp, definePlugin } from '@basaltkit/core'
import { EVENTS, OUTBOX, Outbox, MemoryOutboxStore, defineEvent, eventsPlugin } from '@basaltkit/events'
import { WEBHOOKS, webhookOutboxDispatch, webhookOutboxPlugin } from '../src/index.js'
import type { WebhookManager } from '../src/index.js'
import type { DeliveryResult } from '../src/index.js'

/** A WebhookManager stand-in — real delivery would hit the SSRF guard. */
function fakeWebhooks() {
  const calls: Array<{ event: string; data: unknown; tenantId: string | undefined }> = []
  let results: DeliveryResult[] = [{ endpointId: 'e1', ok: true, attempts: 1 }]
  const manager = {
    async dispatch(event: string, data: unknown, tenantId?: string) {
      calls.push({ event, data, tenantId })
      return results
    },
  } as unknown as WebhookManager
  return { manager, calls, fail: () => (results = [{ endpointId: 'e1', ok: false, attempts: 1, error: 'boom' }]), ok: () => (results = [{ endpointId: 'e1', ok: true, attempts: 1 }]) }
}

const flush = () => new Promise((r) => setImmediate(r))

describe('webhookOutboxDispatch + Outbox (at-least-once)', () => {
  it('retries a failed entry and publishes once the webhook succeeds', async () => {
    const wh = fakeWebhooks()
    const outbox = new Outbox(new MemoryOutboxStore())
    const dispatch = webhookOutboxDispatch(wh.manager)
    await outbox.enqueue('order.created', { id: 'o1' }, 'acme')

    wh.fail()
    expect(await outbox.flush(dispatch)).toEqual({ published: 0, failed: 1 }) // stays pending

    wh.ok()
    expect(await outbox.flush(dispatch)).toEqual({ published: 1, failed: 0 }) // delivered
    expect(await outbox.flush(dispatch)).toEqual({ published: 0, failed: 0 }) // nothing left

    expect(wh.calls.at(-1)).toEqual({ event: 'order.created', data: { id: 'o1' }, tenantId: 'acme' })
  })
})

describe('webhookOutboxPlugin', () => {
  const OrderCreated = defineEvent<{ id: string }>('order.created')

  const boot = async (wh: WebhookManager) => {
    const webhooksStub = definePlugin({
      name: 'basalt:webhooks',
      register({ container }) {
        container.singleton(WEBHOOKS, () => wh)
      },
    })
    return createApp({
      plugins: [eventsPlugin(), webhooksStub, webhookOutboxPlugin({ intervalMs: 0 })],
    }).boot()
  }

  it('captures domain events into the outbox and relays them via webhooks', async () => {
    const wh = fakeWebhooks()
    const app = await boot(wh.manager)

    await app.container.get(EVENTS).emit(OrderCreated, { id: 'o42' })
    await flush()

    // The relay is manual here (intervalMs: 0); a manual flush proves the event
    // was captured into the outbox and is delivered via webhooks.
    const result = await app.container.get(OUTBOX).flush(webhookOutboxDispatch(wh.manager))
    expect(result.published).toBe(1)
    expect(wh.calls[0]).toMatchObject({ event: 'order.created', data: { id: 'o42' } })

    await app.shutdown()
  })
})
