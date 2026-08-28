import { CaptiveDependencyError, CircularDependencyError, UnknownTokenError } from './errors.js'
import type { Token } from './token.js'

export type Lifetime = 'singleton' | 'scoped' | 'transient'

export type Factory<T> = (container: Container) => T

interface Binding<T = unknown> {
  factory: Factory<T>
  lifetime: Lifetime
  /** container where the binding was registered — owner of the singleton instances */
  owner: Container
}

/**
 * Hierarchical DI container.
 *
 * - `singleton`: one instance per application (stored in the container that owns the binding)
 * - `scoped`: one instance per scope (e.g. per request), created in the leaf container
 * - `transient`: new instance on every resolution
 */
export class Container {
  private readonly bindings = new Map<symbol, Binding>()
  private readonly singletons = new Map<symbol, unknown>()
  private readonly scopedInstances = new Map<symbol, unknown>()
  /** Resolution stack for cycle detection — keyed by token symbol, not description. */
  private readonly resolving: { key: symbol; description: string; lifetime: Lifetime }[] = []
  /**
   * How many `singleton` builds are in flight on this container — O(1),
   * allocation-free guard for captive dependencies (a scoped resolution while
   * this is > 0 would be memoized into a singleton that outlives the scope).
   */
  private singletonBuilds = 0
  /** Dependency-graph recorder (devtools) — only set on the root once enabled. */
  private graphRecorder?: {
    nodes: Map<symbol, { description: string; lifetime: Lifetime }>
    edges: Set<string>
  }

  constructor(private readonly parent?: Container) {}

  register<T>(token: Token<T>, factory: Factory<T>, lifetime: Lifetime = 'singleton'): this {
    this.bindings.set(token.key, { factory, lifetime, owner: this })
    return this
  }

  singleton<T>(token: Token<T>, factory: Factory<T>): this {
    return this.register(token, factory, 'singleton')
  }

  scoped<T>(token: Token<T>, factory: Factory<T>): this {
    return this.register(token, factory, 'scoped')
  }

  transient<T>(token: Token<T>, factory: Factory<T>): this {
    return this.register(token, factory, 'transient')
  }

  has<T>(token: Token<T>): boolean {
    return this.findBinding(token.key) !== undefined
  }

  get<T>(token: Token<T>): T {
    const binding = this.findBinding(token.key)
    if (!binding) throw new UnknownTokenError(token.description)

    if (this.resolving.some((entry) => entry.key === token.key)) {
      throw new CircularDependencyError([
        ...this.resolving.map((entry) => entry.description),
        token.description,
      ])
    }

    switch (binding.lifetime) {
      case 'singleton': {
        const store = binding.owner.singletons
        if (!store.has(token.key)) store.set(token.key, this.build(token, binding))
        return store.get(token.key) as T
      }
      case 'scoped': {
        if (this.singletonBuilds > 0) {
          throw new CaptiveDependencyError(token.description, this.enclosingSingleton())
        }
        if (!this.scopedInstances.has(token.key)) {
          this.scopedInstances.set(token.key, this.build(token, binding))
        }
        return this.scopedInstances.get(token.key) as T
      }
      case 'transient':
        return this.build(token, binding) as T
    }
  }

  /** Creates a child scope (e.g. per request). Bindings are inherited; scoped instances are not. */
  createScope(): Container {
    return new Container(this)
  }

  private build<T>(token: Token<T>, binding: Binding): unknown {
    const recorder = this.recorder()
    if (recorder) {
      recorder.nodes.set(token.key, { description: token.description, lifetime: binding.lifetime })
      const parent = this.resolving[this.resolving.length - 1]
      if (parent) recorder.edges.add(`${parent.description}\u0000${token.description}`)
    }
    this.resolving.push({ key: token.key, description: token.description, lifetime: binding.lifetime })
    if (binding.lifetime === 'singleton') this.singletonBuilds += 1
    try {
      return binding.factory(this)
    } finally {
      if (binding.lifetime === 'singleton') this.singletonBuilds -= 1
      this.resolving.pop()
    }
  }

  /** Description of the innermost in-flight singleton build (error path only). */
  private enclosingSingleton(): string {
    for (let i = this.resolving.length - 1; i >= 0; i--) {
      const frame = this.resolving[i]!
      if (frame.lifetime === 'singleton') return frame.description
    }
    return '(unknown)'
  }

  private findBinding(key: symbol): Binding | undefined {
    return this.bindings.get(key) ?? this.parent?.findBinding(key)
  }

  // ---- devtools ----

  /** Enable dependency-graph recording (off by default — zero overhead otherwise). */
  enableGraph(): this {
    this.graphRecorder ??= { nodes: new Map(), edges: new Set() }
    return this
  }

  private recorder(): Container['graphRecorder'] {
    return this.graphRecorder ?? this.parent?.recorder()
  }

  /**
   * The dependency graph observed **so far** — every `A depends on B` edge seen
   * during resolution since `enableGraph()`. Passive: it records real
   * resolutions and never forces eager construction.
   */
  dependencyGraph(): DependencyGraph {
    const recorder = this.recorder()
    if (!recorder) return { nodes: [], edges: [] }
    return {
      nodes: [...recorder.nodes.values()].map((n) => ({ token: n.description, lifetime: n.lifetime })),
      edges: [...recorder.edges].map((e) => {
        const [from = '', to = ''] = e.split('\u0000')
        return { from, to }
      }),
    }
  }

  /** Static snapshot of every reachable binding — token, lifetime, and whether it's been built. */
  describe(): BindingInfo[] {
    const seen = new Set<symbol>()
    const out: BindingInfo[] = []
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    for (let c: Container | undefined = this; c; c = c.parent) {
      for (const [key, binding] of c.bindings) {
        if (seen.has(key)) continue
        seen.add(key)
        const instantiated =
          binding.lifetime === 'singleton'
            ? binding.owner.singletons.has(key)
            : binding.lifetime === 'scoped'
              ? this.scopedInstances.has(key)
              : false
        out.push({ token: describeKey(key), lifetime: binding.lifetime, instantiated })
      }
    }
    return out
  }
}

export interface BindingInfo {
  token: string
  lifetime: Lifetime
  instantiated: boolean
}

export interface DependencyGraph {
  nodes: { token: string; lifetime: Lifetime }[]
  edges: { from: string; to: string }[]
}

/** Best-effort human name for a token key (symbols carry their description). */
function describeKey(key: symbol): string {
  return key.description ?? key.toString()
}
