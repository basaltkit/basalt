import { CircularDependencyError, UnknownTokenError } from './errors.js'
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
  private readonly resolving: { key: symbol; description: string }[] = []

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
    this.resolving.push({ key: token.key, description: token.description })
    try {
      return binding.factory(this)
    } finally {
      this.resolving.pop()
    }
  }

  private findBinding(key: symbol): Binding | undefined {
    return this.bindings.get(key) ?? this.parent?.findBinding(key)
  }
}
