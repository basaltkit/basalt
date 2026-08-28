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

/**
 * A `scoped` token was resolved while a `singleton` was being built. The
 * singleton outlives every scope, so it would permanently capture ONE scope's
 * instance (e.g. request 1's per-request service served to every later
 * request) — the classic captive dependency. Fails loudly instead of
 * capturing silently. Inject the scope-dependent service per call (resolve it
 * from `ctx().container` at use time), or make the dependency transient.
 */
export class CaptiveDependencyError extends BasaltError {
  constructor(scopedToken: string, singletonToken: string) {
    super(
      'DI_CAPTIVE_DEPENDENCY',
      `Scoped token "${scopedToken}" was resolved inside the factory of singleton "${singletonToken}". ` +
        'A singleton outlives every scope, so this would permanently capture one scope\'s instance. ' +
        'Resolve the scoped service at use time (e.g. from ctx().container) instead of at construction.',
    )
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
