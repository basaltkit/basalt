/**
 * Persistence contracts.
 *
 * Both stores take `tenantId` as an **explicit first argument** on every read
 * and write, the same shape `@basaltkit/files`' `FileStore` uses. That is a
 * deliberate isolation decision, not a style one: the tenant is part of the
 * lookup key, so a store cannot accidentally answer a query that was never
 * scoped. A route that forgets to scope does not leak — it fails to find
 * anything. The facade additionally re-checks `record.tenantId` on everything a
 * store returns, so a buggy or third-party store that ignores the argument
 * still cannot widen a result set.
 */

/** Health of a connection's stored credentials. */
export type DriveConnectionStatus =
  /** Usable. */
  | 'active'
  /** The grant is gone (revoked at the provider, expired refresh token). Needs re-consent. */
  | 'invalid'
  /** Disconnected by us. Kept only while a soft-delete window applies. */
  | 'revoked'

/**
 * A tenant's connection to one account at one provider.
 *
 * A tenant may hold **many** connections to the same provider — "Drive Finance"
 * and "Drive HR" are two rows with `provider: 'google'` and different `label`s,
 * different credentials and independent sync cursors. Nothing in the model is
 * keyed by `(tenantId, provider)`, precisely so this works.
 */
export interface DriveConnection {
  id: string
  tenantId: string
  /** {@link DriveProvider.name}. */
  provider: string
  /** Operator-chosen display name. Unique per tenant is a good app-level rule; not enforced here. */
  label: string
  /** Identity at the provider, for display and duplicate detection. Never credentials. */
  account?: DriveConnectionAccount | undefined
  /** Folder the connection is confined to. Absent means the account root. */
  rootId?: string | undefined
  status: DriveConnectionStatus
  scopes?: readonly string[] | undefined
  /**
   * Sealed {@link DriveTokens}, as produced by {@link DriveSecretBox.seal}.
   *
   * Bound by AAD to `(tenantId, id, provider)`, so this column is worthless in
   * any other row. It never leaves this package in readable form and never
   * appears in a {@link DriveConnectionView}.
   */
  secret: string
  /** Incremental-sync cursor / delta token. Opaque. */
  cursor?: string | undefined
  /** Push-subscription state, when the app registered one. */
  watch?: DriveConnectionWatch | undefined
  lastSyncedAt?: number | undefined
  /**
   * Optimistic-concurrency marker, bumped on every write.
   *
   * It exists for one specific failure: two workers refreshing the same
   * connection at the same moment against a provider that **rotates** refresh
   * tokens (Microsoft does). Without it the second write overwrites the first
   * with a refresh token the provider has already retired, and the connection
   * dies at the next refresh. With it the loser is told, re-reads, and uses the
   * winner's tokens.
   */
  revision: number
  createdAt: number
  updatedAt: number
}

export interface DriveConnectionAccount {
  id?: string | undefined
  email?: string | undefined
  name?: string | undefined
}

/** Persisted push-subscription state. `secret` is the value the provider echoes back. */
export interface DriveConnectionWatch {
  id: string
  secret: string
  expiresAt?: number | undefined
  raw?: Record<string, unknown> | undefined
}

/**
 * A connection as the outside world sees it: everything except the credentials.
 *
 * The facade returns only this. Mirrors `@basaltkit/webhooks`'
 * `WebhookEndpointView` — the surest way not to leak a secret through a list
 * endpoint is for the secret never to be in the object the endpoint serialises.
 */
export type DriveConnectionView = Omit<DriveConnection, 'secret' | 'watch'> & {
  /** Whether a push subscription is registered. The subscription secret is never exposed. */
  watching: boolean
}

/**
 * Mutable fields. Spelled out rather than `Partial<>` so it can state the rule a
 * durable store needs: **a key present with `undefined` clears the column, an
 * absent key leaves it alone** — the same contract `@basaltkit/files`' `FilePatch`
 * documents, and the only way to express "drop the cursor" under
 * `exactOptionalPropertyTypes`.
 */
export interface DriveConnectionPatch {
  label?: string
  account?: DriveConnectionAccount | undefined
  status?: DriveConnectionStatus
  scopes?: readonly string[] | undefined
  secret?: string
  cursor?: string | undefined
  watch?: DriveConnectionWatch | undefined
  lastSyncedAt?: number | undefined
  rootId?: string | undefined
}

export interface DriveConnectionListFilter {
  provider?: string | undefined
  status?: DriveConnectionStatus | undefined
}

export interface DriveConnectionStore {
  create(record: DriveConnection): Promise<void>
  find(tenantId: string, id: string): Promise<DriveConnection | null>
  list(tenantId: string, filter?: DriveConnectionListFilter): Promise<DriveConnection[]>
  /**
   * Applies `patch` and bumps `revision`.
   *
   * When `expectedRevision` is given the write applies **only** if the stored
   * revision still matches; otherwise it must return `null` and change nothing.
   * A store that ignores this argument is not safe to run more than one worker
   * against — see {@link DriveConnection.revision}.
   */
  update(
    tenantId: string,
    id: string,
    patch: DriveConnectionPatch,
    expectedRevision?: number,
  ): Promise<DriveConnection | null>
  delete(tenantId: string, id: string): Promise<void>
}

/**
 * One line in the dedup ledger: "this external file, at this version, has
 * already been imported for this tenant and connection".
 *
 * Keyed by `(tenantId, connectionId, externalId)` — connection-scoped, not
 * tenant-scoped, because the same Google file id can legitimately be reachable
 * through two connections and each import lands in its own place.
 */
export interface DriveImportRecord {
  tenantId: string
  connectionId: string
  externalId: string
  /**
   * The identity of the *content* that was imported: the provider's `version`,
   * or its checksum, or a digest of both. Re-importing is decided by comparing
   * this, not by timestamps — `updatedAt` moves when a file is renamed or
   * re-shared, and re-downloading a gigabyte because someone renamed it is a
   * bill, not a feature.
   */
  version: string
  /** What the sink returned — a `@basaltkit/files` record id, or an app row id. */
  targetId: string
  /** Which strategy produced it. A `reference` row has no bytes anywhere. */
  strategy: DriveImportStrategy
  importedAt: number
}

/**
 * Where the bytes end up.
 *
 * - `copy` — download into the app's own storage (`@basaltkit/files` →
 *   `@basaltkit/storage`). The app owns availability, retention and
 *   revocability; the provider can delete or un-share the original and the copy
 *   is still there. Costs storage, and makes the app a controller of that data.
 * - `reference` — record the metadata and the `externalUrl`, download nothing.
 *   Zero storage and zero duplication, but availability, retention and access
 *   all remain the provider's: revoking the connection makes the content
 *   unreachable, and an audit trail can only prove what was *seen*, not what it
 *   said.
 */
export type DriveImportStrategy = 'copy' | 'reference'

export interface DriveImportLedger {
  find(tenantId: string, connectionId: string, externalId: string): Promise<DriveImportRecord | null>
  record(record: DriveImportRecord): Promise<void>
  forget(tenantId: string, connectionId: string, externalId: string): Promise<void>
  /** Everything imported through one connection — used to clean up on disconnect. */
  list(tenantId: string, connectionId: string): Promise<DriveImportRecord[]>
}

/**
 * Tuple-encoded composite key.
 *
 * Joining ids with a separator would let a tenant id that contains the
 * separator address another tenant's row; `JSON.stringify` of the tuple cannot
 * be confused that way. Same reasoning, same technique as
 * `MemoryFileStore.key`.
 */
const key = (...parts: string[]): string => JSON.stringify(parts)

/** In-memory {@link DriveConnectionStore}. Production uses a durable store. */
export class MemoryDriveConnectionStore implements DriveConnectionStore {
  private readonly records = new Map<string, DriveConnection>()

  async create(record: DriveConnection): Promise<void> {
    this.records.set(key(record.tenantId, record.id), { ...record })
  }

  async find(tenantId: string, id: string): Promise<DriveConnection | null> {
    const found = this.records.get(key(tenantId, id))
    return found ? { ...found } : null
  }

  async list(tenantId: string, filter: DriveConnectionListFilter = {}): Promise<DriveConnection[]> {
    const out: DriveConnection[] = []
    for (const record of this.records.values()) {
      if (record.tenantId !== tenantId) continue
      if (filter.provider !== undefined && record.provider !== filter.provider) continue
      if (filter.status !== undefined && record.status !== filter.status) continue
      out.push({ ...record })
    }
    return out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }

  async update(
    tenantId: string,
    id: string,
    patch: DriveConnectionPatch,
    expectedRevision?: number,
  ): Promise<DriveConnection | null> {
    const record = this.records.get(key(tenantId, id))
    if (!record) return null
    if (expectedRevision !== undefined && record.revision !== expectedRevision) return null
    // Object.assign, not a spread of defined keys: an explicitly-undefined key
    // in the patch must clear the field, which is the documented contract.
    Object.assign(record, patch, { revision: record.revision + 1, updatedAt: Date.now() })
    return { ...record }
  }

  async delete(tenantId: string, id: string): Promise<void> {
    this.records.delete(key(tenantId, id))
  }
}

/** In-memory {@link DriveImportLedger}. */
export class MemoryDriveImportLedger implements DriveImportLedger {
  private readonly records = new Map<string, DriveImportRecord>()

  async find(tenantId: string, connectionId: string, externalId: string): Promise<DriveImportRecord | null> {
    // A copy, like every other read here: a caller that mutates what it is
    // handed must not be able to rewrite the ledger by accident.
    const found = this.records.get(key(tenantId, connectionId, externalId))
    return found ? { ...found } : null
  }

  async record(record: DriveImportRecord): Promise<void> {
    this.records.set(key(record.tenantId, record.connectionId, record.externalId), { ...record })
  }

  async forget(tenantId: string, connectionId: string, externalId: string): Promise<void> {
    this.records.delete(key(tenantId, connectionId, externalId))
  }

  async list(tenantId: string, connectionId: string): Promise<DriveImportRecord[]> {
    const out: DriveImportRecord[] = []
    for (const record of this.records.values()) {
      if (record.tenantId === tenantId && record.connectionId === connectionId) out.push({ ...record })
    }
    return out
  }
}
