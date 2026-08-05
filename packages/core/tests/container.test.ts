import { describe, expect, it } from 'vitest'
import { Container, createToken } from '../src/index.js'

interface Greeter {
  greet(): string
}

const GREETER = createToken<Greeter>('greeter')
const COUNTER = createToken<{ n: number }>('counter')

describe('Container', () => {
  it('resolves singletons with the same instance', () => {
    const container = new Container()
    container.singleton(COUNTER, () => ({ n: 0 }))
    container.get(COUNTER).n++
    expect(container.get(COUNTER).n).toBe(1)
  })

  it('resolves transients with fresh instances', () => {
    const container = new Container()
    container.transient(COUNTER, () => ({ n: 0 }))
    container.get(COUNTER).n++
    expect(container.get(COUNTER).n).toBe(0)
  })

  it('scoped: one instance per scope, inheriting bindings from the parent', () => {
    const root = new Container()
    root.scoped(COUNTER, () => ({ n: 0 }))
    const scopeA = root.createScope()
    const scopeB = root.createScope()
    scopeA.get(COUNTER).n = 10
    expect(scopeA.get(COUNTER).n).toBe(10)
    expect(scopeB.get(COUNTER).n).toBe(0)
  })

  it('singleton registered in the parent is shared between scopes', () => {
    const root = new Container()
    root.singleton(COUNTER, () => ({ n: 0 }))
    root.createScope().get(COUNTER).n = 5
    expect(root.createScope().get(COUNTER).n).toBe(5)
  })

  it('injects dependencies via typed factories', () => {
    const container = new Container()
    const NAME = createToken<string>('name')
    container.singleton(NAME, () => 'Machize')
    container.singleton(GREETER, (c) => ({ greet: () => `Olá, ${c.get(NAME)}` }))
    expect(container.get(GREETER).greet()).toBe('Olá, Machize')
  })

  it('throws a typed error for an unknown token', () => {
    const container = new Container()
    expect(() => container.get(GREETER)).toThrowError(/greeter/)
    try {
      container.get(GREETER)
    } catch (error) {
      expect((error as { code: string }).code).toBe('DI_UNKNOWN_TOKEN')
    }
  })

  it('detects circular dependency with the chain in the error', () => {
    const container = new Container()
    const A = createToken<unknown>('a')
    const B = createToken<unknown>('b')
    container.singleton(A, (c) => ({ b: c.get(B) }))
    container.singleton(B, (c) => ({ a: c.get(A) }))
    expect(() => container.get(A)).toThrowError(/a -> b -> a/)
  })
})
