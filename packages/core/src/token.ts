/**
 * Token tipado de injeção de dependência. O parâmetro fantasma `__type`
 * carrega o tipo do serviço em tempo de compilação — nada de reflect-metadata.
 */
export interface Token<T> {
  readonly key: symbol
  readonly description: string
  /** phantom type — nunca existe em runtime */
  readonly __type?: T
}

export function createToken<T>(description: string): Token<T> {
  return { key: Symbol(description), description }
}
