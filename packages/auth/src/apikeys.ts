import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { BasaltError, type HookBus } from '@basaltkit/core'
import { AllowlistError, API_KEY_ALLOWED_IPS_MAX, ipAllowed, normalizeAllowedIps } from './ip-allowlist.js'
import {
  MemoryApiKeyStore,
  type ApiKeyFilter,
  type ApiKeyInfo,
  type ApiKeyPatch,
  type ApiKeyRecord,
  type ApiKeyStore,
} from './stores.js'

export { API_KEY_ALLOWED_IPS_MAX }

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

/** No key with this id in scope, or it is revoked or expired (an expired key is dead: issue a new one). */
export class ApiKeyNotFoundError extends BasaltError {
  readonly status = 404
  constructor() {
    super('AUTH_APIKEY_NOT_FOUND', 'API key not found.')
  }
}

/**
 * Invalid input to an API key operation: a bad `allowedIps` entry, `meta` over
 * its limits, `userId` together with `serviceId`, a malformed `serviceId` or
 * `scopes`, or a rotation `graceMs` out of range.
 */
export class ApiKeyInputError extends BasaltError {
  readonly status = 400
  constructor(message: string) {
    super('AUTH_APIKEY_INPUT_INVALID', message)
  }
}

/** A concurrent rotation or revocation changed the key first; re-read it and retry. */
export class ApiKeyConflictError extends BasaltError {
  readonly status = 409
  constructor() {
    super('AUTH_APIKEY_CONFLICT', 'The API key was changed concurrently; retry.')
  }
}

/** The configured `ApiKeyStore` does not implement `update`, which lifecycle operations need. */
export class ApiKeyStoreUnsupportedError extends BasaltError {
  readonly status = 501
  constructor(operation: string) {
    super(
      'AUTH_APIKEY_STORE_UNSUPPORTED',
      `The API key store does not support "${operation}": it does not implement ApiKeyStore.update.`,
    )
  }
}

/** The key is valid, but the request comes from an address outside its `allowedIps`. */
export class ApiKeyIpNotAllowedError extends BasaltError {
  readonly status = 403
  constructor() {
    super('AUTH_APIKEY_IP_NOT_ALLOWED', 'This API key is not allowed from this address.')
  }
}

/** Longest rotation grace window {@link ApiKeys.rotate} accepts: 30 days (the webhooks secret-rotation cap). */
export const MAX_API_KEY_ROTATION_GRACE_MS = 30 * 24 * 60 * 60 * 1000

/** Limits on a key's `meta`: number of entries, key length, value length. */
export const API_KEY_META_LIMITS = { keys: 20, keyLength: 40, valueLength: 500 } as const

const META_KEY = /^[A-Za-z0-9_.-]+$/
const FORBIDDEN_META_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
/** Printable ASCII without spaces, 1..128 characters. */
const SERVICE_ID = /^[\x21-\x7E]{1,128}$/

/** Validates a key's `meta`; returns a fresh copy. Throws {@link ApiKeyInputError}. */
function normalizeMeta(meta: unknown): Record<string, string> {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    throw new ApiKeyInputError('meta must be an object of string values.')
  }
  const entries = Object.entries(meta)
  if (entries.length > API_KEY_META_LIMITS.keys) {
    throw new ApiKeyInputError(`meta holds at most ${API_KEY_META_LIMITS.keys} entries.`)
  }
  const out: Record<string, string> = {}
  for (const [key, value] of entries) {
    if (FORBIDDEN_META_KEYS.has(key) || !META_KEY.test(key) || key.length > API_KEY_META_LIMITS.keyLength) {
      throw new ApiKeyInputError(
        `meta key ${JSON.stringify(key)} is invalid: 1-${API_KEY_META_LIMITS.keyLength} characters of A-Z, a-z, 0-9, "_", "." or "-" (not __proto__, constructor or prototype).`,
      )
    }
    if (typeof value !== 'string' || value.length > API_KEY_META_LIMITS.valueLength) {
      throw new ApiKeyInputError(
        `meta value of ${JSON.stringify(key)} must be a string of at most ${API_KEY_META_LIMITS.valueLength} characters.`,
      )
    }
    out[key] = value
  }
  return out
}

/** Validates and canonicalises `allowedIps`. Throws {@link ApiKeyInputError}. */
function allowedIpsOf(value: unknown): string[] {
  try {
    return normalizeAllowedIps(value)
  } catch (err) {
    if (err instanceof AllowlistError) throw new ApiKeyInputError(`allowedIps: ${err.message}.`)
    throw err
  }
}

function assertScopes(scopes: unknown): asserts scopes is string[] {
  if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === 'string' && scope.length > 0)) {
    throw new ApiKeyInputError('scopes must be an array of non-empty strings.')
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

/** A fresh secret: the plaintext key, its hash and its display prefix. */
const mintSecret = (): { key: string; hash: string; prefix: string } => {
  const secret = randomBytes(24).toString('base64url')
  const key = `${KEY_PREFIX}${secret}`
  return { key, hash: hashKey(key), prefix: `${KEY_PREFIX}${secret.slice(0, DISPLAY_SECRET_CHARS)}` }
}

/** The public view of a record: never a hash, current or previous. */
const strip = (record: ApiKeyRecord): ApiKeyInfo => {
  const { hash: _hash, previousHash: _previousHash, ...info } = record
  return info
}

const isExpired = (record: ApiKeyRecord, now: number): boolean => record.expiresAt !== undefined && record.expiresAt <= now

/** True when `granted` covers `required` (an exact match or the `*` wildcard). */
export const scopesSatisfy = (granted: readonly string[], required: readonly string[]): boolean =>
  granted.includes('*') || required.every((scope) => granted.includes(scope))

export interface IssueApiKeyInput {
  name: string
  scopes?: string[] | undefined
  tenantId?: string
  /** The user the key acts as. Mutually exclusive with `serviceId`. */
  userId?: string
  expiresAt?: number | undefined
  /**
   * The non-human actor the key acts as (opaque, app-defined, 1-128 printable
   * characters without spaces). Mutually exclusive with `userId`; immutable. A
   * service key never sets `ctx().user`: it is authorized by its scopes and
   * tenant binding only.
   */
  serviceId?: string | undefined
  /** Client addresses or CIDR networks allowed to use the key (at most 32). Absent or empty: any. */
  allowedIps?: string[] | undefined
  /** Flat app metadata, never used for authorization (see {@link API_KEY_META_LIMITS}). */
  meta?: Record<string, string> | undefined
}

/** The mutable fields {@link ApiKeys.update} accepts. `null` clears a field. */
export interface UpdateApiKeyInput {
  name?: string | undefined
  scopes?: string[] | undefined
  /** A future timestamp (ms), or `null` for "never expires". */
  expiresAt?: number | null | undefined
  allowedIps?: string[] | null | undefined
  meta?: Record<string, string> | null | undefined
}

export interface RotateApiKeyOptions {
  /**
   * How long the replaced secret keeps working, in ms. 0 (the default) kills it
   * now — the answer to a leak. At most {@link MAX_API_KEY_ROTATION_GRACE_MS}.
   */
  graceMs?: number | undefined
}

export interface ListApiKeysOptions extends ApiKeyFilter {
  /** Also list keys past their `expiresAt`. Default false. Revoked keys are never listed. */
  includeExpired?: boolean | undefined
}

export interface AuthenticateApiKeyOptions {
  /** The client address, checked against the key's `allowedIps`. */
  ip?: string | undefined
}

/** The outcome of {@link ApiKeys.authenticate}. */
export type ApiKeyAuthResult =
  | { ok: true; record: ApiKeyRecord }
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'ip_not_allowed'; record: ApiKeyRecord }

/** The fields an `auth:apikey_updated` event reports as changed (names only, never values). */
export type ApiKeyUpdatedField = 'name' | 'scopes' | 'expiresAt' | 'allowedIps' | 'meta'

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
 * {@link issue} (and {@link rotate}); only its SHA-256 hash is stored, so a
 * leaked database never yields usable keys.
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
    if (input.serviceId !== undefined) {
      if (input.userId !== undefined) {
        throw new ApiKeyInputError('A key acts as a user or as a service, not both: pass userId or serviceId.')
      }
      if (typeof input.serviceId !== 'string' || !SERVICE_ID.test(input.serviceId)) {
        throw new ApiKeyInputError('serviceId must be 1-128 printable characters without spaces.')
      }
    }
    if (input.scopes !== undefined) assertScopes(input.scopes)
    const allowedIps = input.allowedIps !== undefined ? allowedIpsOf(input.allowedIps) : []
    const meta = input.meta !== undefined ? normalizeMeta(input.meta) : {}
    const { key, hash, prefix } = mintSecret()
    const record: ApiKeyRecord = {
      id: randomUUID(),
      name: input.name,
      prefix,
      hash,
      scopes: input.scopes ?? ['*'],
      createdAt: this.now(),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      ...(input.serviceId !== undefined ? { serviceId: input.serviceId } : {}),
      ...(allowedIps.length > 0 ? { allowedIps } : {}),
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    }
    await this.store.create(record)
    await this.hooks?.emit('auth:apikey_issued', { id: record.id, ...ownerOf(record) })
    return { record: strip(record), key }
  }

  /**
   * Authenticates a presented key. Malformed, unknown, revoked and expired keys
   * are `invalid`; a key whose `allowedIps` does not cover `options.ip` (or
   * that has an allowlist and no ip to check) is `ip_not_allowed`. After a
   * rotation the previous secret is accepted only until
   * `previousHashExpiresAt`, re-checked here and never trusted to the store.
   * Updates `lastUsedAt` on success only, at most once per `touchEveryMs`.
   */
  async authenticate(presented: string, options: AuthenticateApiKeyOptions = {}): Promise<ApiKeyAuthResult> {
    if (!presented.startsWith(KEY_PREFIX)) return { ok: false, reason: 'invalid' }
    const hash = hashKey(presented)
    const record = await this.store.findByHash(hash)
    if (!record) return { ok: false, reason: 'invalid' }
    const now = this.now()
    if (record.hash !== hash) {
      const inGrace =
        record.previousHash === hash && record.previousHashExpiresAt !== undefined && record.previousHashExpiresAt > now
      if (!inGrace) return { ok: false, reason: 'invalid' }
    }
    if (record.revokedAt !== undefined || isExpired(record, now)) return { ok: false, reason: 'invalid' }
    if (!ipAllowed(record.allowedIps, options.ip)) return { ok: false, reason: 'ip_not_allowed', record }
    if (record.lastUsedAt === undefined || now - record.lastUsedAt >= this.touchEveryMs) {
      await this.store.touch(record.id, now)
      record.lastUsedAt = now
    }
    return { ok: true, record }
  }

  /**
   * Resolves a presented key to its record, or null if it's malformed,
   * unknown, revoked, expired, or used from an address outside its
   * `allowedIps`. Updates `lastUsedAt` on a hit, at most once per
   * `touchEveryMs` per key.
   */
  async verify(presented: string, options: AuthenticateApiKeyOptions = {}): Promise<ApiKeyRecord | null> {
    const result = await this.authenticate(presented, options)
    return result.ok ? result.record : null
  }

  /**
   * Live keys matching the filter, without hashes. The filter is re-applied
   * here, so a store that ignores one of its fields never widens the result.
   * Expired keys are listed only with `includeExpired`; revoked ones never.
   */
  async list(options: ListApiKeysOptions): Promise<ApiKeyInfo[]> {
    const { includeExpired = false, ...filter } = options
    const now = this.now()
    return (await this.store.list(filter))
      .filter(
        (record) =>
          record.revokedAt === undefined &&
          (filter.tenantId === undefined || record.tenantId === filter.tenantId) &&
          (filter.userId === undefined || record.userId === filter.userId) &&
          (filter.serviceId === undefined || record.serviceId === filter.serviceId) &&
          (includeExpired || !isExpired(record, now)),
      )
      .map(strip)
  }

  /**
   * Changes a key's mutable fields in ONE store write; all input is validated
   * first. An unknown, revoked or expired key is {@link ApiKeyNotFoundError}:
   * an expired key cannot be renewed, issue a new one. Emits
   * `auth:apikey_updated` with the changed field names (never the values).
   */
  async update(id: string, input: UpdateApiKeyInput): Promise<ApiKeyInfo> {
    const patch: ApiKeyPatch = {}
    const changes: ApiKeyUpdatedField[] = []
    if (input.name !== undefined) {
      if (typeof input.name !== 'string' || input.name.length === 0) throw new ApiKeyInputError('name must be a non-empty string.')
      patch.name = input.name
      changes.push('name')
    }
    if (input.scopes !== undefined) {
      assertScopes(input.scopes)
      patch.scopes = [...input.scopes]
      changes.push('scopes')
    }
    if (input.expiresAt !== undefined) {
      if (input.expiresAt !== null && (!Number.isInteger(input.expiresAt) || input.expiresAt <= this.now())) {
        throw new ApiKeyExpirationError()
      }
      patch.expiresAt = input.expiresAt
      changes.push('expiresAt')
    }
    if (input.allowedIps !== undefined) {
      const allowedIps = input.allowedIps === null ? [] : allowedIpsOf(input.allowedIps)
      patch.allowedIps = allowedIps.length > 0 ? allowedIps : null
      changes.push('allowedIps')
    }
    if (input.meta !== undefined) {
      const meta = input.meta === null ? {} : normalizeMeta(input.meta)
      patch.meta = Object.keys(meta).length > 0 ? meta : null
      changes.push('meta')
    }
    const update = this.requireUpdate('update')
    const current = await this.live(id)
    if (changes.length === 0) return strip(current)
    const updated = await update(id, patch)
    // Revoked between the read and the write.
    if (!updated) throw new ApiKeyNotFoundError()
    await this.hooks?.emit('auth:apikey_updated', { id, ...ownerOf(updated), changes })
    return strip(updated)
  }

  /**
   * Sets when a key expires: a future timestamp (ms), or `null` for never. A
   * thin wrapper over {@link update}; the same "expired is dead" rule applies.
   */
  async setExpiry(id: string, expiresAt: number | null): Promise<ApiKeyInfo> {
    return this.update(id, { expiresAt })
  }

  /**
   * Replaces a key's secret, keeping its id (so its owner, scopes and audit
   * trail stay). With `graceMs` the replaced secret keeps working that long —
   * never past the key's own expiry or revocation; at most two secrets are ever
   * live, so rotating during a grace window drops the oldest. Compare-and-set:
   * when a concurrent rotation or revocation wins, this one throws
   * {@link ApiKeyConflictError}. Returns the new plaintext `key` (shown once).
   */
  async rotate(id: string, options: RotateApiKeyOptions = {}): Promise<{ record: ApiKeyInfo; key: string }> {
    const graceMs = options.graceMs ?? 0
    if (!Number.isInteger(graceMs) || graceMs < 0 || graceMs > MAX_API_KEY_ROTATION_GRACE_MS) {
      throw new ApiKeyInputError(`graceMs must be an integer between 0 and ${MAX_API_KEY_ROTATION_GRACE_MS} (30 days).`)
    }
    const update = this.requireUpdate('rotate')
    const current = await this.live(id)
    const now = this.now()
    const { key, hash, prefix } = mintSecret()
    const graceUntil = graceMs > 0 ? Math.min(now + graceMs, current.expiresAt ?? Number.POSITIVE_INFINITY) : undefined
    const rotated = await update(
      id,
      {
        hash,
        prefix,
        previousHash: graceUntil !== undefined ? current.hash : null,
        previousHashExpiresAt: graceUntil ?? null,
        rotatedAt: now,
      },
      { ifHash: current.hash },
    )
    if (!rotated) throw new ApiKeyConflictError()
    await this.hooks?.emit('auth:apikey_rotated', {
      id,
      ...ownerOf(rotated),
      ...(graceUntil !== undefined ? { graceUntil } : {}),
    })
    return { record: strip(rotated), key }
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

  private requireUpdate(operation: string): NonNullable<ApiKeyStore['update']> {
    const update = this.store.update
    if (typeof update !== 'function') throw new ApiKeyStoreUnsupportedError(operation)
    return update.bind(this.store)
  }

  /** The record behind a lifecycle operation: unknown, revoked and expired keys are all "not found". */
  private async live(id: string): Promise<ApiKeyRecord> {
    const record = await this.store.findById(id)
    if (!record || record.revokedAt !== undefined || isExpired(record, this.now())) throw new ApiKeyNotFoundError()
    return record
  }
}

/** The owner fields every lifecycle hook carries. */
const ownerOf = (record: ApiKeyRecord): { tenantId?: string; userId?: string; serviceId?: string } => ({
  ...(record.tenantId !== undefined ? { tenantId: record.tenantId } : {}),
  ...(record.userId !== undefined ? { userId: record.userId } : {}),
  ...(record.serviceId !== undefined ? { serviceId: record.serviceId } : {}),
})

/** The value stashed on `ctx().apiKey` after a request authenticates with a key. */
export interface ApiKeyContext {
  id: string
  scopes: string[]
  tenantId?: string
  userId?: string
  /** Set for a service key: the non-human actor the request acts as. `ctx().user` is then never set. */
  serviceId?: string
}
