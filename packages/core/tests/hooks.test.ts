import { describe, expect, it } from 'vitest'
import { HookBus } from '../src/index.js'

describe('HookBus.onAny', () => {
  it('receives every emission with the hook name, after specific handlers', async () => {
    const bus = new HookBus()
    const order: string[] = []
    bus.on('auth:login', () => void order.push('specific'))
    bus.onAny((hook) => void order.push(`any:${hook}`))

    await bus.emit('auth:login', { user: 'u1' })
    await bus.emit('billing:subscribed', {})
    expect(order).toEqual(['specific', 'any:auth:login', 'any:billing:subscribed'])
  })

  it('unsubscribes', async () => {
    const bus = new HookBus()
    let calls = 0
    const off = bus.onAny(() => void calls++)
    await bus.emit('x', {})
    off()
    await bus.emit('y', {})
    expect(calls).toBe(1)
  })
})
