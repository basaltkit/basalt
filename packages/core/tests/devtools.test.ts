import { describe, expect, it } from 'vitest'
import { Container, createToken, renderDependencyGraph } from '../src/index.js'

const A = createToken<{ v: number }>('A')
const B = createToken<{ v: number }>('B')
const C = createToken<{ v: number }>('C')

describe('Container.describe()', () => {
  it('lists reachable bindings with lifetime and whether they are built', () => {
    const c = new Container()
    c.singleton(B, () => ({ v: 2 }))
    c.transient(C, () => ({ v: 3 }))
    c.singleton(A, (ct) => ({ v: ct.get(B).v + 1 }))

    const before = c.describe()
    expect(before.map((d) => d.token).sort()).toEqual(['A', 'B', 'C'])
    expect(before.find((d) => d.token === 'A')!.lifetime).toBe('singleton')
    expect(before.find((d) => d.token === 'A')!.instantiated).toBe(false)

    c.get(A)
    const after = c.describe()
    expect(after.find((d) => d.token === 'A')!.instantiated).toBe(true)
    expect(after.find((d) => d.token === 'B')!.instantiated).toBe(true)
  })
})

describe('dependency graph', () => {
  it('records edges from real resolutions once enabled', () => {
    const c = new Container()
    c.enableGraph()
    c.singleton(B, () => ({ v: 2 }))
    c.singleton(A, (ct) => ({ v: ct.get(B).v + 1 }))
    c.get(A)

    const g = c.dependencyGraph()
    expect(g.nodes.map((n) => n.token).sort()).toEqual(['A', 'B'])
    expect(g.edges).toContainEqual({ from: 'A', to: 'B' })
  })

  it('is empty (zero overhead) when not enabled', () => {
    const c = new Container()
    c.singleton(B, () => ({ v: 2 }))
    c.get(B)
    expect(c.dependencyGraph()).toEqual({ nodes: [], edges: [] })
  })

  it('renders Mermaid', () => {
    const c = new Container().enableGraph()
    c.singleton(B, () => ({ v: 2 }))
    c.singleton(A, (ct) => ({ v: ct.get(B).v + 1 }))
    c.get(A)
    const mermaid = renderDependencyGraph(c.dependencyGraph())
    expect(mermaid).toContain('graph TD')
    expect(mermaid).toMatch(/n_A\["A/)
    expect(mermaid).toContain('n_A --> n_B')
  })
})
