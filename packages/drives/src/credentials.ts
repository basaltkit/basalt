import { DriveCredentialsInvalidError } from './errors.js'
import type { GuardedFetch } from './fetch.js'
import type { DriveAuthorization, DriveTokens } from './provider.js'
import type { DriveSecretBox } from './secret-box.js'
import type { DriveConnection, DriveConnectionStore } from './store.js'

/**
 * Credential lifecycle: unseal, decide whether the access token is still good,
 * refresh exactly once when it is not, persist rotation, and fail closed when
 * the grant is gone.
 *
 * Everything here exists because of one asymmetry: an access token is cheap and
 * short-lived, a **refresh token is the account**. Losing one logs a tenant out
 * of their own drive; leaking one hands over their documents until a human
 * notices. So the refresh token is never handed to an adapter, never logged,
 * never placed in an error, and never overwritten by a stale writer.
 */

/** Seconds of headroom: refresh before the token actually expires, not after it fails. */
export const DEFAULT_REFRESH_SKEW_MS = 60_000

/** The shape stored inside the sealed envelope. */
interface StoredTokens extends DriveTokens {
  /** When these tokens were written; useful for diagnostics that must not read the tokens. */
  storedAt: number
}

export interface CredentialsOptions {
  store: DriveConnectionStore
  box: DriveSecretBox
  /**
   * The guarded fetch a refresh call may use, per connection.
   *
   * A refresh talks to the provider's token endpoint, which is as much an SSRF
   * and timeout surface as a download is — so it goes through the same door.
   * Required rather than optional: an implicit fallback to global `fetch` is
   * exactly the kind of unguarded path that survives review by being invisible.
   */
  fetchFor: (connection: DriveConnection) => GuardedFetch
  now?: () => number
  /** How long before expiry a token counts as expired. Default 60 s. */
  refreshSkewMs?: number
  /** Called after a successful refresh, for hooks/audit. Never receives a token. */
  onRefreshed?: (info: { connection: DriveConnection; rotated: boolean }) => void | Promise<void>
  /** Called when the grant is terminally gone. Never receives a token. */
  onInvalidated?: (info: { connection: DriveConnection; reason: string }) => void | Promise<void>
}

/** What a caller gets back: a usable access token and the connection it came from. */
export interface ActiveCredentials {
  accessToken: string
  connection: DriveConnection
}

export class DriveCredentials {
  private readonly now: () => number
  private readonly skew: number
  /**
   * In-flight refreshes, keyed by tenant+connection.
   *
   * Single-flight inside one process: twenty concurrent import jobs on the same
   * connection perform **one** refresh, not twenty. That matters beyond
   * efficiency — for a provider that rotates refresh tokens, twenty concurrent
   * refreshes are twenty attempts to spend the same one-time token, nineteen of
   * which fail and any of which could be the one that gets persisted.
   *
   * Across processes the optimistic `revision` check in `store.update` is what
   * keeps a loser from overwriting a winner; see the class note there.
   */
  private readonly inFlight = new Map<string, Promise<ActiveCredentials>>()

  constructor(private readonly options: CredentialsOptions) {
    this.now = options.now ?? Date.now
    this.skew = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS
  }

  /** Seals a token set for storage against one connection's identity. */
  seal(tokens: DriveTokens, context: { tenantId: string; connectionId: string; provider: string }): string {
    const stored: StoredTokens = { ...tokens, storedAt: this.now() }
    return this.options.box.seal(JSON.stringify(stored), context)
  }

  /** Unseals the tokens of a connection. Throws if the envelope does not authenticate. */
  private unseal(connection: DriveConnection): StoredTokens {
    const json = this.options.box.open(connection.secret, {
      tenantId: connection.tenantId,
      connectionId: connection.id,
      provider: connection.provider,
    })
    return JSON.parse(json) as StoredTokens
  }

  /** Whether a token set needs refreshing before use. */
  private expired(tokens: DriveTokens): boolean {
    // No expiry means "unknown", not "never". Treating unknown as valid is the
    // right default here: the alternative is refreshing on every single call,
    // and a 401 still triggers a reactive refresh through `refreshNow`.
    return tokens.expiresAt !== undefined && tokens.expiresAt - this.skew <= this.now()
  }

  /**
   * Returns a usable access token for `connection`, refreshing first if needed.
   *
   * Refuses outright for a connection that is not `active`: a connection whose
   * grant we already know is gone must not generate provider traffic on every
   * queued job.
   */
  async use(connection: DriveConnection, authorization: DriveAuthorization): Promise<ActiveCredentials> {
    if (connection.status !== 'active') {
      throw new DriveCredentialsInvalidError(connection.id, `the connection is ${connection.status}.`)
    }
    const tokens = this.unseal(connection)
    if (!this.expired(tokens)) return { accessToken: tokens.accessToken, connection }
    return this.refresh(connection, authorization)
  }

  /**
   * Forces a refresh — what a caller does after the provider answers 401 with a
   * token we believed was still valid (clock skew, a revoked-then-reissued
   * grant, a provider that expires early under load).
   */
  async refreshNow(connection: DriveConnection, authorization: DriveAuthorization): Promise<ActiveCredentials> {
    return this.refresh(connection, authorization)
  }

  private async refresh(
    connection: DriveConnection,
    authorization: DriveAuthorization,
    attempt = 1,
  ): Promise<ActiveCredentials> {
    const flightKey = JSON.stringify([connection.tenantId, connection.id])
    const existing = this.inFlight.get(flightKey)
    if (existing) return existing

    const flight = this.performRefresh(connection, authorization, attempt).finally(() => {
      this.inFlight.delete(flightKey)
    })
    this.inFlight.set(flightKey, flight)
    return flight
  }

  /**
   * How many times a lost compare-and-set may send us round again.
   *
   * Two is enough for the real race (another worker committed between our read
   * and our write); more than that is a livelock, and a livelock against a
   * token endpoint is an outage with someone else's name on it.
   */
  private static readonly MAX_CAS_ATTEMPTS = 3

  private async performRefresh(
    connection: DriveConnection,
    authorization: DriveAuthorization,
    attempt: number,
  ): Promise<ActiveCredentials> {
    const current = this.unseal(connection)
    if (current.refreshToken === undefined) {
      // Nothing to refresh with and the access token is past its expiry. This is
      // terminal, not transient: retrying cannot produce a refresh token.
      await this.invalidate(connection, 'the access token expired and no refresh token was stored.')
      throw new DriveCredentialsInvalidError(connection.id, 'no refresh token is stored.')
    }

    let fresh: DriveTokens
    try {
      fresh = await authorization.refresh({
        refreshToken: current.refreshToken,
        fetch: this.options.fetchFor(connection),
      })
    } catch (error) {
      if (error instanceof DriveCredentialsInvalidError) {
        // The adapter recognised a terminal provider answer (invalid_grant,
        // consent revoked) — but "terminal" has two very different causes, and
        // getting them confused breaks working connections.
        //
        // Under refresh-token ROTATION, a second worker that refreshed this
        // same connection a moment ago has already retired the token we just
        // tried to spend. The provider's answer is identical to a revoked
        // grant, yet the connection is perfectly healthy: the winner stored
        // usable credentials. So before condemning it, look.
        const latest = await this.options.store.find(connection.tenantId, connection.id)
        if (latest && latest.status === 'active' && latest.revision !== connection.revision) {
          const latestTokens = this.unseal(latest)
          if (!this.expired(latestTokens)) return { accessToken: latestTokens.accessToken, connection: latest }
        }
        // Nobody refreshed behind our back: the grant really is gone. Stop
        // using this connection rather than hammering the provider from every
        // queued job until someone notices.
        await this.invalidate(connection, 'the provider rejected the stored refresh token.')
      }
      throw error
    }

    const rotated = fresh.refreshToken !== undefined && fresh.refreshToken !== current.refreshToken
    const merged: DriveTokens = {
      accessToken: fresh.accessToken,
      // Keep the old refresh token when the provider did not send a new one:
      // Google and Dropbox routinely omit it on refresh, and dropping it would
      // break the connection on the *next* cycle rather than this one.
      refreshToken: fresh.refreshToken ?? current.refreshToken,
      ...(fresh.expiresAt !== undefined ? { expiresAt: fresh.expiresAt } : {}),
      ...(fresh.scopes !== undefined ? { scopes: fresh.scopes } : {}),
    }

    const sealed = this.seal(merged, {
      tenantId: connection.tenantId,
      connectionId: connection.id,
      provider: connection.provider,
    })
    const updated = await this.options.store.update(
      connection.tenantId,
      connection.id,
      { secret: sealed, ...(merged.scopes !== undefined ? { scopes: merged.scopes } : {}) },
      connection.revision,
    )

    if (!updated) {
      // Someone else wrote to this connection while we were talking to the
      // provider, so our compare-and-set lost. We do NOT overwrite them: under
      // refresh-token rotation the token we just spent may already be retired,
      // and clobbering the winner's row would break the connection outright.
      const latest = await this.options.store.find(connection.tenantId, connection.id)
      if (!latest || latest.status !== 'active') {
        throw new DriveCredentialsInvalidError(connection.id, 'the connection was invalidated during a refresh.')
      }
      const latestTokens = this.unseal(latest)
      // Losing the race does not by itself mean the winner refreshed — they may
      // have only renamed the connection. Re-check rather than assume: handing
      // back a token that is still expired would surface as a mystery 401 one
      // call later, a long way from the cause.
      if (!this.expired(latestTokens)) return { accessToken: latestTokens.accessToken, connection: latest }
      if (attempt >= DriveCredentials.MAX_CAS_ATTEMPTS) {
        throw new DriveCredentialsInvalidError(
          connection.id,
          'the credentials could not be refreshed without colliding with another writer.',
        )
      }
      // Straight to performRefresh, NOT back through `refresh`: we are running
      // inside this connection's own in-flight entry, so re-entering the
      // single-flight map would hand us back the promise we are currently
      // executing and deadlock.
      return this.performRefresh(latest, authorization, attempt + 1)
    }

    await this.options.onRefreshed?.({ connection: updated, rotated })
    return { accessToken: merged.accessToken, connection: updated }
  }

  private async invalidate(connection: DriveConnection, reason: string): Promise<void> {
    const updated = await this.options.store.update(connection.tenantId, connection.id, { status: 'invalid' })
    await this.options.onInvalidated?.({ connection: updated ?? connection, reason })
  }
}
