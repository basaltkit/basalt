import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { BasaltError, type HookBus } from '@basaltkit/core'
import {
  MemoryApiKeyStore,
  type ApiKeyFilter,
  type ApiKeyInfo,
  type ApiKeyRecord,
  type ApiKeyStore,
} from './stores.js'

/** A route required a scope the presented key does not hold. */
export class ScopeRequiredError extends BasaltError {
  readonly status = 403
  constructor(scope: string) {
    super('AUTH_SCOPE_REQUIRED', `This action requires the "${scope}" scope.`)
  }
}

export class ApiKeyExpirationError extends BasaltError {
  readonly status = 400
  constructor() {
    super('AUTH_APIKEY_EXPIRATION_INVALID', 'API key expiration must be a future timestamp.')
  }
}

/** The prefix on every key. `mk` = Basalt key, `live` = environment. */
const KEY_PREFIX = 'mk_live_'
/** Secret characters kept in the display prefix (`ApiKeyRecord.prefix`). */
const DISPLAY_SECRET_CHARS = 6

/**
 * The display prefix of a presented key (`mk_live_` plus the first six secret
 * characters), the same value `ApiKeyRecord.prefix` stores and listings show.
 * Undefined for anything that is not shaped like a Basalt key, so an unrelated
 * secret sent by mistake is never echoed into a hook payload or a log.
 */
export const apiKeyDisplayPrefix = (presented: string): string | undefined =>
  presented.startsWith(KEY_PREFIX) && presented.length >= KEY_PREFIX.length + DISPLAY_SECRET_CHARS
    ? presented.slice(0, KEY_PREFIX.length + DISPLAY_SECRET_CHARS)
    : undefined

/** SHA-256 is safe here: API keys are high-entropy, so no slow hash is needed. */
const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex')

const strip = (record: ApiKeyRecord): ApiKeyInfo => {
  const { hash: _hash, ...info } = record
  return info
}

/** True when `granted` covers `required` (an exact match or the `*` wildcard). */
export const scopesSatisfy = (granted: readonly string[], required: readonly string[]): boolean =>
  granted.includes('*') || required.every((scope) => granted.includes(scope))

export interface IssueApiKeyInput {
  name: string
  scopes?: string[] | undefined
  tenantId?: string
  userId?: string
  expiresAt?: number | undefined
}

export interface ApiKeysOptions {
  store?: ApiKeyStore
  hooks?: HookBus
  /** Injectable clock — tests and deterministic runs override it. */
  now?: () => number
  /**
   * Minimum interval, in milliseconds, between two `lastUsedAt` writes for the
   * same key. A machine client calling once a second would otherwise cost one
   * store write per request. `lastUsedAt` is therefore accurate to within this
   * window. `0` writes on every verification (the pre-4.2 behaviour).
   * Default 60_000.
   */
  touchEveryMs?: number
}

export class ApiKeyOptionsError extends BasaltError {
  readonly status = 500
  constructor(message: string) {
    super('AUTH_APIKEY_OPTIONS_INVALID', message)
  }
}

/** Default `touchEveryMs`: one `lastUsedAt` write per key per minute. */
export const DEFAULT_API_KEY_TOUCH_EVERY_MS = 60_000

/** Resolves and validates `touchEveryMs`; throws {@link ApiKeyOptionsError}. */
export function resolveTouchEveryMs(value: number | undefined): number {
  const touchEveryMs = value ?? DEFAULT_API_KEY_TOUCH_EVERY_MS
  if (typeof touchEveryMs !== 'number' || !Number.isFinite(touchEveryMs) || touchEveryMs < 0) {
    throw new ApiKeyOptionsError(`apiKeys: touchEveryMs must be a finite number >= 0 (got ${String(touchEveryMs)}).`)
  }
  return touchEveryMs
}

/**
 * Issues and verifies API keys. The plaintext key is returned exactly once by
 * {@link issue}; only its SHA-256 hash is stored, so a leaked database never
 * yields usable keys.
 */
export class ApiKeys {
  private readonly store: ApiKeyStore
  private readonly hooks: HookBus | undefined
  private readonly now: () => number
  private readonly touchEveryMs: number

  constructor(options: ApiKeysOptions = {}) {
    this.store = options.store ?? new MemoryApiKeyStore()
    this.hooks = options.hooks
    this.now = options.now ?? Date.now
    this.touchEveryMs = resolveTouchEveryMs(options.touchEveryMs)
  }

  /** Mints a key. Returns the record plus the plaintext `key` (shown once). */
  async issue(input: IssueApiKeyInput): Promise<{ record: ApiKeyInfo; key: string }> {
    if (input.expiresAt !== undefined && (!Number.isInteger(input.expiresAt) || input.expiresAt <= this.now())) {
      throw new ApiKeyExpirationError()
    }
    const secret = randomBytes(24).toString('base64url')
    const key = `${KEY_PREFIX}${secret}`
    const record: ApiKeyRecord = {
      id: randomUUID(),
      name: input.name,
      prefix: `${KEY_PREFIX}${secret.slice(0, DISPLAY_SECRET_CHARS)}`,
      hash: hashKey(key),
      scopes: input.scopes ?? ['*'],
      createdAt: this.now(),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
    }
    await this.store.create(record)
    await this.hooks?.emit('auth:apikey_issued', {
      id: record.id,
      ...(record.tenantId !== undefined ? { tenantId: record.tenantId } : {}),
      ...(record.userId !== undefined ? { userId: record.userId } : {}),
    })
    return { record: strip(record), key }
  }

  /**
   * Resolves a presented key to its record, or null if it's malformed,
   * unknown, or revoked. Updates `lastUsedAt` on a hit, at most once per
   * `touchEveryMs` per key.
   */
  async verify(presented: string): Promise<ApiKeyRecord | null> {
    if (!presented.startsWith(KEY_PREFIX)) return null
    const record = await this.store.findByHash(hashKey(presented))
    const now = this.now()
    if (!record || record.revokedAt !== undefined || (record.expiresAt !== undefined && record.expiresAt <= now)) return null
    if (record.lastUsedAt === undefined || now - record.lastUsedAt >= this.touchEveryMs) {
      await this.store.touch(record.id, now)
    }
    return record
  }

  async list(filter: ApiKeyFilter): Promise<ApiKeyInfo[]> {
    return (await this.store.list(filter)).filter((record) => record.expiresAt === undefined || record.expiresAt > this.now()).map(strip)
  }

  /** Revokes a key by id. No-op if unknown or already revoked. */
  async revoke(id: string): Promise<void> {
    const record = await this.store.findById(id)
    if (record && record.revokedAt === undefined) {
      await this.store.revoke(id, this.now())
      await this.hooks?.emit('auth:apikey_revoked', { id })
    }
  }

  /**
   * Revokes every live key owned by the user — for when the account's previous
   * holder is no longer trusted (e.g. a verified social login adopted it).
   */
  async revokeAllForUser(userId: string): Promise<void> {
    for (const record of await this.store.list({ userId })) {
      if (record.userId === userId) await this.revoke(record.id)
    }
  }

  /** Reads a single key's public info (used to authorize a revoke). */
  async get(id: string): Promise<ApiKeyInfo | null> {
    const record = await this.store.findById(id)
    return record ? strip(record) : null
  }
}

/** The value stashed on `ctx().apiKey` after a request authenticates with a key. */
export interface ApiKeyContext {
  id: string
  scopes: string[]
  tenantId?: string
  userId?: string
}
