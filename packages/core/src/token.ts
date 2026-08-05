/**
 * Typed dependency-injection token. The phantom parameter `__type`
 * carries the service type at compile time — no reflect-metadata.
 */
export interface Token<T> {
  readonly key: symbol
  readonly description: string
  /** phantom type — never exists at runtime */
  readonly __type?: T
}

export function createToken<T>(description: string): Token<T> {
  return { key: Symbol(description), description }
}
