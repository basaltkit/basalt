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

describe('HookBus.emit isolates handlers (review 2026-08-b, Q-1)', () => {
  it('a throwing handler no longer starves later handlers or onAny (audit) — but still surfaces', async () => {
    const bus = new HookBus()
    const ran: string[] = []
    bus.on('order:created', () => {
      ran.push('first')
      throw new Error('listener down')
    })
    bus.on('order:created', () => void ran.push('second'))
    bus.onAny(() => void ran.push('audit'))

    await expect(bus.emit('order:created', {})).rejects.toThrowError('listener down')
    // EVERY handler ran despite the failure — the audit trail never has holes.
    expect(ran).toEqual(['first', 'second', 'audit'])
  })

  it('a single failure rethrows the ORIGINAL error (no wrapper surprise)', async () => {
    const bus = new HookBus()
    const boom = new Error('specific')
    bus.on('x', () => {
      throw boom
    })
    await expect(bus.emit('x', {})).rejects.toBe(boom)
  })

  it('multiple failures aggregate', async () => {
    const bus = new HookBus()
    bus.on('x', () => {
      throw new Error('one')
    })
    bus.on('x', () => {
      throw new Error('two')
    })
    const error = await bus.emit('x', {}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toHaveLength(2)
  })

  it('onAny failures also surface without starving other onAny handlers', async () => {
    const bus = new HookBus()
    const ran: string[] = []
    bus.onAny(() => {
      throw new Error('any-1 down')
    })
    bus.onAny(() => void ran.push('any-2'))
    await expect(bus.emit('x', {})).rejects.toThrowError('any-1 down')
    expect(ran).toEqual(['any-2'])
  })
})
