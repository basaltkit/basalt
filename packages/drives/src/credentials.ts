import { DriveCredentialsInvalidError } from './errors.js'
import type { GuardedFetch } from './fetch.js'
import type { DriveAuthorization, DriveTokens } from './provider.js'
import type { DriveSecretBox } from './secret-box.js'
import { healthPatch, type DriveConnection, type DriveConnectionStore } from './store.js'

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
      // terminal, not transient: retrying cannot produce a refresh token —
      // unless another writer stored one meanwhile, which `condemn` checks.
      const adopted = await this.condemn(connection, undefined, 'the access token expired and no refresh token was stored.')
      if (adopted) return adopted
      throw new DriveCredentialsInvalidError(connection.id, 'no refresh token is stored.')
    }

    let fresh: DriveTokens
    try {
      fresh = await authorization.refresh({
        refreshToken: current.refreshToken,
        fetch: this.options.fetchFor(connection),
        // The scopes this connection actually consented to, not the adapter's
        // defaults: Microsoft wants a refresh scoped to a subset of the
        // original grant, and guessing narrows a connection silently.
        ...(current.scopes !== undefined ? { scopes: current.scopes } : {}),
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
        // (or is about to store) usable credentials. `condemn` only marks the
        // row invalid if it still holds the very token that was rejected, and
        // does so with a compare-and-set, so it can never overwrite a winner.
        const adopted = await this.condemn(connection, current.refreshToken, 'the provider rejected the stored refresh token.')
        if (adopted) return adopted
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
      if (latest && latest.status === 'invalid' && this.unseal(latest).refreshToken === current.refreshToken) {
        // The other writer was a LOSER, not a winner: it presented the refresh
        // token we had just spent, was told `invalid_grant`, and — seeing no
        // newer credentials yet — marked the connection invalid. Its evidence
        // was about the token we retired; the grant is alive, and the fresh
        // tokens in our hands are the only live refresh token in existence.
        // Dropping them here would log the tenant out for good, so restore the
        // connection — still by compare-and-set, against the row we just read,
        // so a disconnect or a re-consent in the meantime is never undone.
        const restored = await this.options.store.update(
          connection.tenantId,
          connection.id,
          { secret: sealed, status: 'active', ...(merged.scopes !== undefined ? { scopes: merged.scopes } : {}) },
          latest.revision,
        )
        if (restored) {
          await this.options.onRefreshed?.({ connection: restored, rotated })
          return { accessToken: merged.accessToken, connection: restored }
        }
      }
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

  /**
   * Marks a connection `invalid` — but only if it still holds the refresh token
   * the provider just rejected, and only by compare-and-set.
   *
   * An unconditional write here was the race behind FA-074: a worker that got
   * `invalid_grant` for a token a concurrent winner had already rotated away
   * re-read the row, saw nothing new *yet*, and wrote `status: 'invalid'` on
   * top of whatever the winner stored a moment later. So instead:
   *
   * - the row is re-read, and if it now holds **different** credentials the
   *   rejection was about a token that is no longer the connection's — those
   *   credentials are adopted when still valid, and nothing is condemned;
   * - otherwise the invalidation is written with `expectedRevision`, and a lost
   *   compare-and-set sends us round again to look at what the other writer
   *   stored.
   *
   * Returns credentials to use when another writer's turned out to be good,
   * `undefined` when the caller should throw.
   */
  private async condemn(
    connection: DriveConnection,
    rejected: string | undefined,
    reason: string,
  ): Promise<ActiveCredentials | undefined> {
    let latest = await this.options.store.find(connection.tenantId, connection.id)
    for (let attempt = 1; ; attempt++) {
      // Gone, already invalid, or disconnected: nothing to condemn.
      if (!latest || latest.status !== 'active') return undefined
      const tokens = this.unseal(latest)
      if (tokens.refreshToken !== rejected) {
        // Somebody stored newer credentials. Use them if they are still good;
        // if not, the next call refreshes with *them*. Either way, the
        // rejection we saw says nothing about this connection any more.
        return this.expired(tokens) ? undefined : { accessToken: tokens.accessToken, connection: latest }
      }
      const updated = await this.options.store.update(
        connection.tenantId,
        connection.id,
        // Health stamped in the same compare-and-set write: no extra write and
        // no extra revision bump on the refresh path.
        {
          status: 'invalid',
          ...healthPatch(this.options.store, { lastFailedAt: this.now(), lastErrorCode: 'DRIVE_CREDENTIALS_INVALID' }),
        },
        latest.revision,
      )
      if (updated) {
        await this.options.onInvalidated?.({ connection: updated, reason })
        return undefined
      }
      // Lost the compare-and-set: somebody wrote between our read and our
      // write. Bounded, for the same livelock reason as the refresh loop — and
      // on giving up we leave the row alone rather than condemn it blind.
      if (attempt >= DriveCredentials.MAX_CAS_ATTEMPTS) return undefined
      latest = await this.options.store.find(connection.tenantId, connection.id)
    }
  }
}
