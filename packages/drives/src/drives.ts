import { randomUUID } from 'node:crypto'
import type { HookBus } from '@basaltkit/core'
import { tryCtx } from '@basaltkit/core'
import {
  DriveAuthorizationFlow,
  assertRedirectUri,
  type DriveAuthorizationStart,
} from './authorization.js'
import { DriveCredentials } from './credentials.js'
import {
  DriveConnectionNotFoundError,
  DriveCredentialsInvalidError,
  DriveProviderUnknownError,
  DriveTenantMismatchError,
  DriveTenantRequiredError,
  DriveUnsupportedError,
} from './errors.js'
import { createDriveFetch, type GuardedFetch } from './fetch.js'
import type {
  DriveAccount,
  DriveContent,
  DriveItem,
  DriveListOptions,
  DrivePage,
  DriveProvider,
  DriveSession,
  DriveTokens,
  DriveUploadInput,
} from './provider.js'
import { withRetry, type DriveRetryPolicy } from './retry.js'
import { DriveSecretBox, randomToken, type DriveEncryptionKey } from './secret-box.js'
import {
  MemoryDriveConnectionStore,
  MemoryDriveImportLedger,
  type DriveConnection,
  type DriveConnectionListFilter,
  type DriveConnectionStore,
  type DriveConnectionView,
  type DriveImportLedger,
} from './store.js'

/** Single-tenant apps still need a key for the composite store keys. */
export const SINGLE_TENANT_SCOPE = 'default'

/**
 * What happened when `disconnect` tried to revoke the grant at the provider.
 *
 * `revoked: false` used to be the whole answer, and it meant three different
 * things an operator has to act on differently:
 *
 * - `revoked` — the provider accepted it. The grant is gone.
 * - `skipped` — the caller asked for a local-only disconnect (`revoke: false`).
 * - `unsupported` — the adapter has **no revocation endpoint to call**, and
 *   never will. Microsoft Graph is this: there is no per-application revoke, so
 *   the grant lives until the user removes it at `myaccount.microsoft.com`.
 *   Nothing an operator retries will change it.
 * - `failed` — we asked and the provider did not answer: it was down, or the
 *   token was already dead. The grant **may still be live**, and unlike
 *   `unsupported` this is worth trying again.
 *
 * Distinguishing the last two is the point. RFC 0002 §D.3.1 identified the
 * ambiguity and left it documented rather than encoded, on the grounds that a
 * third connection *status* would carry one vendor's absence into every
 * adapter. That reasoning is sound and does not apply here: this is decided
 * entirely by the engine, from facts it already has, and no adapter gains a
 * member or changes a line. Meanwhile the guide's own example branched on the
 * boolean to tell the user to go and withdraw consent by hand — the right
 * advice for `unsupported` and the wrong advice for `failed`.
 */
export type DriveRevocationOutcome = 'revoked' | 'skipped' | 'unsupported' | 'failed'

/** Hooks this package emits. Named `<domain>:<verb>` like every other Basalt package. */
declare module '@basaltkit/core' {
  interface BasaltHooks {
    'drive:connected': { tenantId: string; connectionId: string; provider: string; label: string }
    'drive:disconnected': {
      tenantId: string
      connectionId: string
      provider: string
      /** Whether the grant was actually revoked at the provider. */
      revoked: boolean
      /** Why, when it was not — see {@link DriveRevocationOutcome}. */
      revocation: DriveRevocationOutcome
    }
    'drive:credentials_refreshed': { tenantId: string; connectionId: string; provider: string; rotated: boolean }
    'drive:credentials_invalid': { tenantId: string; connectionId: string; provider: string; reason: string }
  }
}

export interface DrivesOptions {
  /** Adapters the app has installed. */
  providers: readonly DriveProvider[]
  /**
   * Encryption key ring for credentials at rest. The first key seals new
   * secrets; the rest stay readable so rotation is a rolling change.
   */
  keys: readonly DriveEncryptionKey[]
  /** Signs the OAuth `state`. Typically the app secret (`env.APP_SECRET`). */
  secret: string
  store?: DriveConnectionStore
  ledger?: DriveImportLedger
  hooks?: HookBus
  /** Default byte cap for a single downloaded file. Default 100 MiB (see `DEFAULT_MAX_BYTES`). */
  maxBytes?: number
  /** Whole-exchange timeout for one provider call. Default 30 s. */
  timeoutMs?: number
  /** Retry policy for transient provider failures. */
  retry?: DriveRetryPolicy
  /** Escape hatch for a self-hosted provider on a private network. Off by default. */
  allowPrivateHosts?: boolean
  /** Injected DNS resolver (tests). */
  lookup?: (host: string) => Promise<{ address: string; family?: number }[]>
  /** Injected transport (tests). */
  transport?: Parameters<typeof createDriveFetch>[0]['transport']
  now?: () => number
}

export interface ConnectInput {
  provider: string
  label: string
  tokens: DriveTokens
  tenantId?: string
  rootId?: string
  account?: DriveAccount
}

export interface DisconnectOptions {
  tenantId?: string
  /**
   * Also ask the provider to revoke the grant. Default `true`.
   *
   * Defaulting to revoke is the fail-closed choice: "disconnect" means the app
   * should no longer be able to read the user's files, and a row deleted from
   * our database while the grant lives on at the provider does not achieve
   * that — it only makes the remaining access invisible to us.
   */
  revoke?: boolean
}

/**
 * The application-facing facade.
 *
 * Every method resolves the tenant the same way `@basaltkit/files` does, and
 * for the same reason: an ambient tenant in the ALS context always wins, an
 * explicit `tenantId` is honoured only when it agrees or when there is no
 * context tenant at all (jobs, CLI). A route that forwards `?tenantId=` from
 * the client therefore cannot read another tenant's connections — it gets
 * {@link DriveTenantMismatchError}.
 */
export class Drives {
  private readonly providers = new Map<string, DriveProvider>()
  private readonly store: DriveConnectionStore
  private readonly ledger: DriveImportLedger
  private readonly box: DriveSecretBox
  private readonly credentials: DriveCredentials
  private readonly flow: DriveAuthorizationFlow
  private readonly hooks: HookBus | undefined
  private readonly now: () => number
  private readonly retry: DriveRetryPolicy

  constructor(
    private readonly options: DrivesOptions,
    /**
     * Whether `@basaltkit/tenancy` is registered. Wired by `drivesPlugin` to the
     * container's `'tenancy:active'` marker — a signal, not an import, so this
     * package never depends on the tenancy layer.
     */
    private readonly tenancyActive: () => boolean = () => false,
  ) {
    for (const provider of options.providers) this.providers.set(provider.name, provider)
    this.store = options.store ?? new MemoryDriveConnectionStore()
    this.ledger = options.ledger ?? new MemoryDriveImportLedger()
    this.box = new DriveSecretBox(options.keys)
    this.hooks = options.hooks
    this.now = options.now ?? Date.now
    this.retry = options.retry ?? {}
    this.flow = new DriveAuthorizationFlow(options.secret, { now: this.now })
    this.credentials = new DriveCredentials({
      store: this.store,
      box: this.box,
      fetchFor: (connection) => this.fetchFor(this.provider(connection.provider)),
      now: this.now,
      onRefreshed: ({ connection, rotated }) =>
        this.hooks?.emit('drive:credentials_refreshed', {
          tenantId: connection.tenantId,
          connectionId: connection.id,
          provider: connection.provider,
          rotated,
        }),
      onInvalidated: ({ connection, reason }) =>
        this.hooks?.emit('drive:credentials_invalid', {
          tenantId: connection.tenantId,
          connectionId: connection.id,
          provider: connection.provider,
          reason,
        }),
    })
  }

  /** Registered provider names. */
  providerNames(): string[] {
    return [...this.providers.keys()]
  }

  private provider(name: string): DriveProvider {
    const found = this.providers.get(name)
    if (!found) throw new DriveProviderUnknownError(name, this.providerNames())
    return found
  }

  /**
   * The tenant this call is scoped to.
   *
   * Identical rules to `resolveFileTenant` in `@basaltkit/files`, deliberately:
   * an app that has internalised one set of tenancy semantics should not have
   * to learn a second.
   */
  private tenant(explicit: string | undefined, operation: string): string {
    const ambient = (tryCtx()?.['tenant'] as { id?: string } | undefined)?.id
    if (ambient) {
      if (explicit !== undefined && explicit !== ambient) throw new DriveTenantMismatchError()
      return ambient
    }
    if (explicit) return explicit
    if (this.tenancyActive()) throw new DriveTenantRequiredError(operation)
    return SINGLE_TENANT_SCOPE
  }

  private fetchFor(provider: DriveProvider): GuardedFetch {
    return createDriveFetch({
      allowedHosts: provider.allowedHosts,
      provider: provider.name,
      ...(this.options.maxBytes !== undefined ? { maxBytes: this.options.maxBytes } : {}),
      ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
      ...(this.options.allowPrivateHosts ? { allowPrivateHosts: true } : {}),
      ...(this.options.lookup ? { lookup: this.options.lookup } : {}),
      ...(this.options.transport ? { transport: this.options.transport } : {}),
      // Only the adapter knows where its vendor hides a retry hint that is not
      // in `Retry-After`; the engine still decides how long it will honour one.
      ...(provider.retryAfterFromBody
        ? { retryAfterFromBody: (body: string): number | undefined => provider.retryAfterFromBody!(body) }
        : {}),
    })
  }

  // ---------------------------------------------------------------- connect

  /**
   * Step 1 of connecting: where to send the browser.
   *
   * The returned `binding` must go into an `HttpOnly` cookie and come back at
   * the callback — see {@link DriveAuthorizationStart.binding}.
   */
  startAuthorization(input: { provider: string; redirectUri: string; tenantId?: string; scopes?: readonly string[] }): DriveAuthorizationStart {
    const provider = this.provider(input.provider)
    const tenantId = this.tenant(input.tenantId, 'startAuthorization')
    assertRedirectUri(input.redirectUri)
    const { state, binding, codeChallenge } = this.flow.start({
      provider: provider.name,
      tenantId,
      redirectUri: input.redirectUri,
      ...(input.scopes ? { scopes: input.scopes } : {}),
    })
    return {
      url: provider.authorization.authorizeUrl({
        redirectUri: input.redirectUri,
        state,
        codeChallenge,
        ...(input.scopes ? { scopes: input.scopes } : {}),
      }),
      binding,
      state,
    }
  }

  /**
   * Step 2: verify the callback, exchange the code, store the connection.
   *
   * A tenant may complete this many times for the same provider — each call
   * creates a **new** connection with its own label, credentials and cursor.
   * That is the "Drive Finance" / "Drive HR" requirement, and it falls out of
   * the model rather than being a special case.
   */
  async completeAuthorization(input: {
    provider: string
    code: string
    redirectUri: string
    state: string | undefined
    binding: string | undefined
    label: string
    tenantId?: string
    rootId?: string
  }): Promise<DriveConnectionView> {
    const provider = this.provider(input.provider)
    const tenantId = this.tenant(input.tenantId, 'completeAuthorization')
    assertRedirectUri(input.redirectUri)
    const { codeVerifier } = this.flow.complete({
      provider: provider.name,
      tenantId,
      state: input.state,
      binding: input.binding,
    })
    const fetch = this.fetchFor(provider)
    const tokens = await provider.authorization.exchange({
      code: input.code,
      redirectUri: input.redirectUri,
      codeVerifier,
      fetch,
    })
    return this.connect({
      provider: provider.name,
      label: input.label,
      tokens,
      tenantId,
      ...(input.rootId !== undefined ? { rootId: input.rootId } : {}),
    })
  }

  /**
   * Stores a connection from tokens the app already holds.
   *
   * Separate from {@link completeAuthorization} so a service-account or
   * device-code flow — which some tenants require, and which has no browser
   * redirect at all — can still produce a connection.
   */
  async connect(input: ConnectInput): Promise<DriveConnectionView> {
    const provider = this.provider(input.provider)
    const tenantId = this.tenant(input.tenantId, 'connect')
    const id = randomUUID()
    const timestamp = this.now()

    let account = input.account
    if (account === undefined && provider.authorization.account) {
      // Best effort: knowing which account was connected is display data, and
      // failing the whole connect because the profile call hiccuped would be a
      // poor trade for the user who just consented.
      try {
        account = await provider.authorization.account(
          this.sessionFor({ accessToken: input.tokens.accessToken, tenantId, connectionId: id, rootId: input.rootId }, provider),
        )
      } catch {
        account = undefined
      }
    }

    const connection: DriveConnection = {
      id,
      tenantId,
      provider: provider.name,
      label: input.label,
      status: 'active',
      secret: this.credentials.seal(input.tokens, { tenantId, connectionId: id, provider: provider.name }),
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(account !== undefined ? { account } : {}),
      ...(input.rootId !== undefined ? { rootId: input.rootId } : {}),
      ...(input.tokens.scopes !== undefined ? { scopes: input.tokens.scopes } : {}),
    }
    await this.store.create(connection)
    await this.hooks?.emit('drive:connected', { tenantId, connectionId: id, provider: provider.name, label: input.label })
    return toView(connection)
  }

  /** Connections of the current tenant. Credentials are never part of the result. */
  async list(filter: DriveConnectionListFilter & { tenantId?: string } = {}): Promise<DriveConnectionView[]> {
    const { tenantId: explicit, ...rest } = filter
    const tenantId = this.tenant(explicit, 'list')
    const records = await this.store.list(tenantId, rest)
    // Re-filtered here on purpose: a store that ignores its tenant argument
    // (a custom one, a buggy one) must not be able to widen a listing.
    return records.filter((record) => record.tenantId === tenantId).map(toView)
  }

  /** One connection, or {@link DriveConnectionNotFoundError}. */
  async get(connectionId: string, tenantId?: string): Promise<DriveConnectionView> {
    return toView(await this.require(connectionId, tenantId, 'get'))
  }

  private async require(connectionId: string, tenantId: string | undefined, operation: string): Promise<DriveConnection> {
    const scope = this.tenant(tenantId, operation)
    const record = await this.store.find(scope, connectionId)
    // The second check is not redundant with passing `scope` to `find`: it is
    // the backstop for a store implementation that looks up by id alone.
    if (!record || record.tenantId !== scope) throw new DriveConnectionNotFoundError(connectionId)
    return record
  }

  /**
   * Disconnects: revokes at the provider (best effort, on by default), then
   * deletes the row and its credentials.
   *
   * The dedup ledger is **kept**. Files already imported under `copy` still
   * exist in the app's storage and still need their provenance; dropping the
   * ledger would make a re-connect re-import everything as if it were new.
   * {@link forgetImports} is the explicit way to ask for the other behaviour.
   */
  async disconnect(connectionId: string, options: DisconnectOptions = {}): Promise<void> {
    const connection = await this.require(connectionId, options.tenantId, 'disconnect')
    const provider = this.provider(connection.provider)
    const revoke = options.revoke !== false
    let revoked = false
    // Decided up front so the two "we did not revoke" cases stay distinguishable:
    // an adapter with no `revoke` will never have one, while a call that threw
    // is worth trying again.
    let revocation: DriveRevocationOutcome = !revoke
      ? 'skipped'
      : provider.authorization.revoke === undefined
        ? 'unsupported'
        : 'failed'

    if (revoke && provider.authorization.revoke) {
      try {
        const tokens = JSON.parse(
          this.box.open(connection.secret, {
            tenantId: connection.tenantId,
            connectionId: connection.id,
            provider: connection.provider,
          }),
        ) as DriveTokens
        await provider.authorization.revoke({ tokens, fetch: this.fetchFor(provider) })
        revoked = true
        revocation = 'revoked'
      } catch {
        // A provider that is down, or a grant already revoked from the vendor's
        // own console, must not leave an undeletable row behind. The local
        // credentials still go away; `revocation: 'failed'` records that the
        // remote grant may survive **and that asking again might work** — which
        // is the part `revoked: false` alone could never say.
        revoked = false
        revocation = 'failed'
      }
    }

    if (provider.unwatch && connection.watch) {
      try {
        const { accessToken } = await this.credentials.use(connection, provider.authorization)
        await provider.unwatch(this.sessionFor({ accessToken, tenantId: connection.tenantId, connectionId: connection.id, rootId: connection.rootId }, provider), connection.watch)
      } catch {
        // Same reasoning: a dangling subscription at the provider is noise, a
        // row we cannot delete is a bug.
      }
    }

    await this.store.delete(connection.tenantId, connection.id)
    await this.hooks?.emit('drive:disconnected', {
      tenantId: connection.tenantId,
      connectionId: connection.id,
      provider: connection.provider,
      revoked,
      revocation,
    })
  }

  /** Drops the dedup ledger for a connection, so a later sync re-imports everything. */
  async forgetImports(connectionId: string, tenantId?: string): Promise<number> {
    const scope = this.tenant(tenantId, 'forgetImports')
    const records = await this.ledger.list(scope, connectionId)
    for (const record of records) await this.ledger.forget(scope, connectionId, record.externalId)
    return records.length
  }

  // ------------------------------------------------------------- operations

  /** Builds the minimal session an adapter is allowed to see. */
  private sessionFor(
    input: { accessToken: string; tenantId: string; connectionId: string; rootId?: string | undefined; signal?: AbortSignal | undefined },
    provider: DriveProvider,
  ): DriveSession {
    return {
      accessToken: input.accessToken,
      connectionId: input.connectionId,
      tenantId: input.tenantId,
      fetch: this.fetchFor(provider),
      ...(input.rootId !== undefined ? { rootId: input.rootId } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    }
  }

  /**
   * Runs one provider call with a fresh token, retry/backoff, and a single
   * reactive refresh if the provider rejects a token we believed was valid.
   *
   * @internal used by the facade and the sync engine.
   */
  async run<T>(
    connection: DriveConnection,
    operation: (session: DriveSession, provider: DriveProvider) => Promise<T>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const provider = this.provider(connection.provider)
    let current = connection
    /**
     * The reactive refresh is allowed **once per `run`**, not once per retry
     * attempt: a genuinely dead grant must not be able to drive one token-endpoint
     * call per attempt, which is how one broken connection gets a whole
     * application throttled.
     */
    let reactiveRefreshUsed = false

    const sessionWith = (accessToken: string): DriveSession =>
      this.sessionFor(
        {
          accessToken,
          tenantId: current.tenantId,
          connectionId: current.id,
          rootId: current.rootId,
          ...(options.signal ? { signal: options.signal } : {}),
        },
        provider,
      )

    return withRetry(async () => {
      const { accessToken, connection: refreshed } = await this.credentials.use(current, provider.authorization)
      current = refreshed
      try {
        return await operation(sessionWith(accessToken), provider)
      } catch (error) {
        // A token we believed was valid was rejected anyway — clock skew, a
        // provider that expires early under load, a grant reissued behind our
        // back, or simply an access token with no `expires_in` (the contract
        // treats an unknown expiry as "still good", so this is the only thing
        // that catches it). Phase 1 documented this reactive refresh on `run`
        // and did not implement it: `DRIVE_CREDENTIALS_INVALID` is terminal
        // for `withRetry`, so the call failed and the tenant saw a dead
        // connection. Refresh once, then try the operation again.
        if (reactiveRefreshUsed || !(error instanceof DriveCredentialsInvalidError)) throw error
        reactiveRefreshUsed = true
        const { accessToken: renewed, connection: rotated } = await this.credentials.refreshNow(
          current,
          provider.authorization,
        )
        current = rotated
        return await operation(sessionWith(renewed), provider)
      }
    }, this.retry)
  }

  /** Loads a connection and runs an operation on it. */
  private async withConnection<T>(
    connectionId: string,
    tenantId: string | undefined,
    operation: string,
    body: (connection: DriveConnection) => Promise<T>,
  ): Promise<T> {
    return body(await this.require(connectionId, tenantId, operation))
  }

  /** One page of a folder listing. */
  async listItems(
    connectionId: string,
    options: DriveListOptions & { tenantId?: string; signal?: AbortSignal } = {},
  ): Promise<DrivePage<DriveItem>> {
    const { tenantId, signal, ...listOptions } = options
    return this.withConnection(connectionId, tenantId, 'listItems', (connection) =>
      this.run(connection, (session, provider) => provider.list(session, listOptions), signal ? { signal } : {}),
    )
  }

  /** Metadata for one item. */
  async getItem(connectionId: string, externalId: string, options: { tenantId?: string; signal?: AbortSignal } = {}): Promise<DriveItem | null> {
    return this.withConnection(connectionId, options.tenantId, 'getItem', (connection) =>
      this.run(
        connection,
        (session, provider) => {
          if (!provider.get) throw new DriveUnsupportedError(provider.name, 'get')
          return provider.get(session, externalId)
        },
        options.signal ? { signal: options.signal } : {},
      ),
    )
  }

  /**
   * Opens an item's bytes.
   *
   * The caller **must** consume or destroy the returned stream. Nothing is
   * buffered here — the stream goes straight into `@basaltkit/files`, which
   * streams it on into the storage driver's `putStream`.
   */
  async download(connectionId: string, item: DriveItem, options: { tenantId?: string; signal?: AbortSignal } = {}): Promise<DriveContent> {
    return this.withConnection(connectionId, options.tenantId, 'download', (connection) =>
      this.run(connection, (session, provider) => provider.download(session, item), options.signal ? { signal: options.signal } : {}),
    )
  }

  /** Writes a file back to the provider, when the adapter supports it. */
  async upload(connectionId: string, input: DriveUploadInput, options: { tenantId?: string; signal?: AbortSignal } = {}): Promise<DriveItem> {
    return this.withConnection(connectionId, options.tenantId, 'upload', (connection) =>
      this.run(
        connection,
        (session, provider) => {
          if (!provider.upload) throw new DriveUnsupportedError(provider.name, 'upload')
          return provider.upload(session, input)
        },
        options.signal ? { signal: options.signal } : {},
      ),
    )
  }

  /** @internal — the sync engine and the import pipeline need these. */
  get internals(): {
    store: DriveConnectionStore
    ledger: DriveImportLedger
    require: (connectionId: string, tenantId: string | undefined, operation: string) => Promise<DriveConnection>
    provider: (name: string) => DriveProvider
    now: () => number
    hooks: HookBus | undefined
    newSecret: () => string
  } {
    return {
      store: this.store,
      ledger: this.ledger,
      require: (connectionId, tenantId, operation) => this.require(connectionId, tenantId, operation),
      provider: (name) => this.provider(name),
      now: this.now,
      hooks: this.hooks,
      newSecret: () => randomToken(),
    }
  }
}

/** Strips credentials. The only conversion from a record to something returnable. */
export function toView(connection: DriveConnection): DriveConnectionView {
  const { secret: _secret, watch, ...rest } = connection
  return { ...rest, watching: watch !== undefined }
}
