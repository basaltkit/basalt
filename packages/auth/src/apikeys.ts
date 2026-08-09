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

/** The prefix on every key. `mk` = Basalt key, `live` = environment. */
const KEY_PREFIX = 'mk_live_'

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
}

export interface ApiKeysOptions {
  store?: ApiKeyStore
  hooks?: HookBus
  /** Injectable clock — tests and deterministic runs override it. */
  now?: () => number
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

  constructor(options: ApiKeysOptions = {}) {
    this.store = options.store ?? new MemoryApiKeyStore()
    this.hooks = options.hooks
    this.now = options.now ?? Date.now
  }

  /** Mints a key. Returns the record plus the plaintext `key` (shown once). */
  async issue(input: IssueApiKeyInput): Promise<{ record: ApiKeyInfo; key: string }> {
    const secret = randomBytes(24).toString('base64url')
    const key = `${KEY_PREFIX}${secret}`
    const record: ApiKeyRecord = {
      id: randomUUID(),
      name: input.name,
      prefix: `${KEY_PREFIX}${secret.slice(0, 6)}`,
      hash: hashKey(key),
      scopes: input.scopes ?? ['*'],
      createdAt: this.now(),
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
   * unknown, or revoked. Updates `lastUsedAt` on a hit.
   */
  async verify(presented: string): Promise<ApiKeyRecord | null> {
    if (!presented.startsWith(KEY_PREFIX)) return null
    const record = await this.store.findByHash(hashKey(presented))
    if (!record || record.revokedAt !== undefined) return null
    await this.store.touch(record.id, this.now())
    return record
  }

  async list(filter: ApiKeyFilter): Promise<ApiKeyInfo[]> {
    return (await this.store.list(filter)).map(strip)
  }

  /** Revokes a key by id. No-op if unknown or already revoked. */
  async revoke(id: string): Promise<void> {
    const record = await this.store.findById(id)
    if (record && record.revokedAt === undefined) {
      await this.store.revoke(id, this.now())
      await this.hooks?.emit('auth:apikey_revoked', { id })
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
