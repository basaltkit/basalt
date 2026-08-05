import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createApp } from '@machize/core'
import { defineEvent, EventBus, EVENTS, eventsPlugin, EventValidationError } from '../src/index.js'

const OrderCreated = defineEvent('order.created', z.object({ orderId: z.string() }))
const AppBooted = defineEvent('app.booted')

describe('EventBus', () => {
  it('emite evento tipado com payload validado', async () => {
    const bus = new EventBus()
    const seen: string[] = []
    bus.on(OrderCreated, ({ orderId }) => void seen.push(orderId))
    await bus.emit(OrderCreated, { orderId: 'o-1' })
    expect(seen).toEqual(['o-1'])
  })

  it('rejeita payload inválido com erro tipado antes de chamar listeners', async () => {
    const bus = new EventBus()
    let called = false
    bus.on(OrderCreated, () => void (called = true))
    await expect(
      bus.emit(OrderCreated, { orderId: 123 as unknown as string }),
    ).rejects.toBeInstanceOf(EventValidationError)
    expect(called).toBe(false)
  })

  it('suporta eventos sem payload', async () => {
    const bus = new EventBus()
    let called = false
    bus.on(AppBooted, () => void (called = true))
    await bus.emit(AppBooted)
    expect(called).toBe(true)
  })

  it('wildcards: * casa um segmento, ** casa qualquer sufixo', async () => {
    const bus = new EventBus()
    const seen: string[] = []
    bus.on('order.*', (_p, meta) => void seen.push(`um:${meta.name}`))
    bus.on('order.**', (_p, meta) => void seen.push(`todos:${meta.name}`))
    bus.on('**', (_p, meta) => void seen.push(`global:${meta.name}`))

    await bus.emit(OrderCreated, { orderId: 'o-1' })
    const PaymentFailed = defineEvent('order.payment.failed')
    await bus.emit(PaymentFailed)

    expect(seen).toEqual([
      'um:order.created',
      'todos:order.created',
      'global:order.created',
      'todos:order.payment.failed',
      'global:order.payment.failed',
    ])
  })

  it('executa por prioridade e respeita once/unsubscribe', async () => {
    const bus = new EventBus()
    const order: string[] = []
    bus.on(AppBooted, () => void order.push('baixa'), { priority: -1 })
    bus.on(AppBooted, () => void order.push('alta'), { priority: 10 })
    bus.once(AppBooted, () => void order.push('once'))
    const off = bus.on(AppBooted, () => void order.push('removido'))
    off()

    await bus.emit(AppBooted)
    await bus.emit(AppBooted)
    expect(order).toEqual(['alta', 'once', 'baixa', 'alta', 'baixa'])
  })

  it('todos os listeners rodam mesmo com falha; erros são agregados', async () => {
    const bus = new EventBus()
    const seen: string[] = []
    bus.on(AppBooted, () => {
      throw new Error('listener quebrado')
    })
    bus.on(AppBooted, () => void seen.push('sobrevivente'))

    await expect(bus.emit(AppBooted)).rejects.toSatisfy((error: AggregateError) => {
      expect(error.errors).toHaveLength(1)
      return true
    })
    expect(seen).toEqual(['sobrevivente'])
  })

  it('eventsPlugin registra o bus no container', async () => {
    const app = await createApp({ plugins: [eventsPlugin()] }).boot()
    const bus = app.container.get(EVENTS)
    let called = false
    bus.on(AppBooted, () => void (called = true))
    await bus.emit(AppBooted)
    expect(called).toBe(true)
  })
})
