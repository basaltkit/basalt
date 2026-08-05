/**
 * Erro base de todo o ecossistema. O `code` é estável e faz parte do
 * contrato semver — apps podem fazer branch por código com segurança.
 */
export class MachizeError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
    this.code = code
  }
}

export class ContextUnavailableError extends MachizeError {
  constructor() {
    super(
      'CONTEXT_UNAVAILABLE',
      'ctx() foi chamado fora de um contexto ativo. Envolva a chamada com runWithContext() ' +
        '(o adaptador HTTP e os workers fazem isso automaticamente).',
    )
  }
}

export class UnknownTokenError extends MachizeError {
  constructor(description: string) {
    super(
      'DI_UNKNOWN_TOKEN',
      `Nenhum provider registrado para o token "${description}". ` +
        'Registre-o com container.singleton()/scoped()/transient() em algum plugin.',
    )
  }
}

export class CircularDependencyError extends MachizeError {
  constructor(chain: string[]) {
    super('DI_CIRCULAR_DEPENDENCY', `Dependência circular detectada: ${chain.join(' -> ')}`)
  }
}

export class PluginDependencyError extends MachizeError {
  constructor(message: string) {
    super('PLUGIN_DEPENDENCY', message)
  }
}

export class ConfigValidationError extends MachizeError {
  constructor(
    readonly plugin: string,
    readonly issues: unknown,
  ) {
    super(
      'CONFIG_INVALID',
      `Configuração inválida para o plugin "${plugin}": ${JSON.stringify(issues, null, 2)}`,
    )
  }
}

export class LifecycleError extends MachizeError {
  constructor(message: string) {
    super('LIFECYCLE', message)
  }
}
