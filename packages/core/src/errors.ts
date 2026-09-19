/**
 * Options for every `BasaltError` — the standard `cause`, plus an optional
 * structured payload.
 */
export interface BasaltErrorOptions extends ErrorOptions {
  /**
   * Machine-readable data about this failure, for the caller to act on:
   * which checks failed, how much quota is left, the current version behind a
   * conflict. Without it the only place to put that data is the human-readable
   * message, and the UI ends up parsing sentences.
   *
   * When the error carries a numeric `status`, `@basaltkit/http` serialises a
   * sanitised copy of this as `error.details` in the HTTP body — so treat it as
   * PUBLIC: no secrets, no internals, plain JSON data only, and small. See the
   * rules in `@basaltkit/http`'s "Structured error details".
   */
  details?: Record<string, unknown>
}

/**
 * Base error for the whole ecosystem. The `code` is stable and part of the
 * semver contract — apps can safely branch on codes.
 */
export class BasaltError extends Error {
  readonly code: string

  /** Structured payload passed to the constructor, exactly as given (never sanitised here). */
  readonly details?: Record<string, unknown>

  constructor(code: string, message: string, options?: BasaltErrorOptions) {
    super(message, options)
    this.name = new.target.name
    this.code = code
    if (options?.details) this.details = options.details
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
