/**
 * Base error for the whole ecosystem. The `code` is stable and part of the
 * semver contract — apps can safely branch on codes.
 */
export class BasaltError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
    this.code = code
  }
}

export class ContextUnavailableError extends BasaltError {
  constructor() {
    super(
      'CONTEXT_UNAVAILABLE',
      'ctx() was called outside of an active context. Wrap the call with runWithContext() ' +
        '(the HTTP adapter and the workers do this automatically).',
    )
  }
}

export class UnknownTokenError extends BasaltError {
  constructor(description: string) {
    super(
      'DI_UNKNOWN_TOKEN',
      `No provider registered for token "${description}". ` +
        'Register it with container.singleton()/scoped()/transient() in some plugin.',
    )
  }
}

export class CircularDependencyError extends BasaltError {
  constructor(chain: string[]) {
    super('DI_CIRCULAR_DEPENDENCY', `Circular dependency detected: ${chain.join(' -> ')}`)
  }
}

export class PluginDependencyError extends BasaltError {
  constructor(message: string) {
    super('PLUGIN_DEPENDENCY', message)
  }
}

export class ConfigValidationError extends BasaltError {
  constructor(
    readonly plugin: string,
    readonly issues: unknown,
  ) {
    super(
      'CONFIG_INVALID',
      `Invalid configuration for plugin "${plugin}": ${JSON.stringify(issues, null, 2)}`,
    )
  }
}

export class LifecycleError extends BasaltError {
  constructor(message: string) {
    super('LIFECYCLE', message)
  }
}
