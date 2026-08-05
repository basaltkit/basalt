import { describe, expect, it } from 'vitest'
import { Container, createToken } from '../src/index.js'

interface Greeter {
  greet(): string
}

const GREETER = createToken<Greeter>('greeter')
const COUNTER = createToken<{ n: number }>('counter')

describe('Container', () => {
  it('resolve singletons com a mesma instância', () => {
    const container = new Container()
    container.singleton(COUNTER, () => ({ n: 0 }))
    container.get(COUNTER).n++
    expect(container.get(COUNTER).n).toBe(1)
  })

  it('resolve transients com instâncias novas', () => {
    const container = new Container()
    container.transient(COUNTER, () => ({ n: 0 }))
    container.get(COUNTER).n++
    expect(container.get(COUNTER).n).toBe(0)
  })

  it('scoped: uma instância por escopo, herdando bindings do pai', () => {
    const root = new Container()
    root.scoped(COUNTER, () => ({ n: 0 }))
    const scopeA = root.createScope()
    const scopeB = root.createScope()
    scopeA.get(COUNTER).n = 10
    expect(scopeA.get(COUNTER).n).toBe(10)
    expect(scopeB.get(COUNTER).n).toBe(0)
  })

  it('singleton registrado no pai é compartilhado entre escopos', () => {
    const root = new Container()
    root.singleton(COUNTER, () => ({ n: 0 }))
    root.createScope().get(COUNTER).n = 5
    expect(root.createScope().get(COUNTER).n).toBe(5)
  })

  it('injeta dependências via factory com tipos', () => {
    const container = new Container()
    const NAME = createToken<string>('name')
    container.singleton(NAME, () => 'Machize')
    container.singleton(GREETER, (c) => ({ greet: () => `Olá, ${c.get(NAME)}` }))
    expect(container.get(GREETER).greet()).toBe('Olá, Machize')
  })

  it('lança erro tipado para token desconhecido', () => {
    const container = new Container()
    expect(() => container.get(GREETER)).toThrowError(/greeter/)
    try {
      container.get(GREETER)
    } catch (error) {
      expect((error as { code: string }).code).toBe('DI_UNKNOWN_TOKEN')
    }
  })

  it('detecta dependência circular com a cadeia no erro', () => {
    const container = new Container()
    const A = createToken<unknown>('a')
    const B = createToken<unknown>('b')
    container.singleton(A, (c) => ({ b: c.get(B) }))
    container.singleton(B, (c) => ({ a: c.get(A) }))
    expect(() => container.get(A)).toThrowError(/a -> b -> a/)
  })
})
