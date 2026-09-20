import { rawBody, route, type BasaltRoute, type HttpReply, type HttpRequest, type RawBody } from '@basaltkit/http'
import { ctx, type Container } from '@basaltkit/core'
import { z } from 'zod'
import type { Drives } from './drives.js'
import { DriveAuthorizationInvalidError, DriveNotificationInvalidError } from './errors.js'
import {
  handleNotification,
  type DriveConnectionCandidates,
  type DriveNotificationQuery,
  type NotificationReplayGuard,
} from './notifications.js'
import { DRIVES } from './plugin.js'
import type { DriveNotificationInput } from './provider.js'
import type { DriveConnection, DriveConnectionView } from './store.js'

/**
 * The HTTP surface RFC 0002 deferred out of phase 1: the connect handshake and
 * **one** notification endpoint that answers all three vendors.
 *
 * Every route is built with `route()` from `@basaltkit/http`, so the same
 * definitions serve unchanged on Fastify, Express and Hono. There is a parity
 * suite (`tests/routes-adapters.test.ts`) that boots all three and asserts they
 * answer identically, including the Dropbox challenge handshake and a signed
 * notification.
 *
 * ## Why one notification route and not one per vendor
 *
 * The three handshakes look different and are the same shape underneath:
 * something arrives that is not a notification, and the provider wants it
 * echoed verbatim before it will deliver anything.
 * {@link DriveNotificationResult.challenge} was designed in phase 1 for exactly
 * this, and it holds up:
 *
 * | Vendor | Handshake | What this route does |
 * |---|---|---|
 * | Dropbox | `GET ?challenge=…`, **before any connection exists** | echoes it as `text/plain` with `nosniff`, touching no connection |
 * | Microsoft Graph | `POST ?validationToken=…`, answered within seconds | same path, same echo |
 * | Google Drive | a `sync` state message on the first delivery | verified, matched, reported as `no-change` |
 *
 * ## The security properties this route is responsible for
 *
 * - **A challenge is answered without consulting any connection.** Dropbox
 *   verifies the URI when it is *saved in the App Console* — there is nothing
 *   to look up yet, and looking anything up would be a lie about what the echo
 *   proves.
 * - **The echo is `text/plain` with `X-Content-Type-Options: nosniff`.** It is
 *   attacker-chosen text reflected verbatim; without those two headers a
 *   browser talked into visiting the URL renders it, and the webhook endpoint
 *   becomes a reflected-XSS gadget on the app's own origin.
 * - **A verified notification always answers 200 `{received:true}`**, whether it
 *   matched a connection, matched several, matched one in another tenant, or
 *   matched nothing at all. Anything else turns the endpoint into an oracle for
 *   which accounts a deployment holds. Only a notification that fails
 *   *verification* answers 400.
 * - **Nothing in the body is ever treated as data.** A verified notification
 *   causes a sync to be *scheduled* for connections we already hold, using our
 *   own credentials. The blast radius of a perfect forgery is a wasted sync.
 * - **The raw bytes are required, never reconstructed.** The delivery route
 *   declares its body with `rawBody()` from `@basaltkit/http`, so all three
 *   adapters hand it the exact octets that arrived — no wiring, no
 *   adapter-specific probes, and no way for a re-serialised body to stand in
 *   for the message that was signed.
 */

/** Default mount prefix. */
export const DEFAULT_DRIVES_BASE_PATH = '/drives'
/** Default name of the cookie that binds an authorization to one browser. */
export const DEFAULT_CONNECT_COOKIE = 'bk_drive_connect'
/**
 * Most bytes of a notification body that will be read.
 *
 * All three vendors send a payload measured in hundreds of bytes. The cap is
 * what stops an unauthenticated endpoint from being a memory amplifier, and it
 * is applied before the signature is checked because reading is what costs.
 */
export const DEFAULT_NOTIFICATION_MAX_BYTES = 64 * 1024

export interface DriveNotificationRoutes {
  /**
   * Candidate connections for an inbound notification.
   *
   * For a per-tenant callback URL, an array or a resolver that reads that
   * tenant's rows. For Dropbox — whose webhook is registered once per app —
   * a resolver that looks connections up by `(provider, accountIds)`; see
   * {@link DriveConnectionCandidates} for why that cross-tenant lookup is safe
   * and why it stays the app's query.
   */
  connections: DriveConnectionCandidates
  /**
   * Called when a verified notification means there is new work.
   *
   * **Enqueue; never sync inline.** Dropbox retries and eventually disables a
   * webhook URI that is slow, and a notification can fan out to several
   * connections. This is the seam where `@basaltkit/queue` belongs.
   */
  onChange: (connections: readonly DriveConnection[], query: DriveNotificationQuery) => Promise<void> | void
  /** Collapses duplicate deliveries. Back it with `@basaltkit/cache` in a cluster. */
  replayGuard?: NotificationReplayGuard
  /** Replay window. Default 5 minutes. */
  replayTtlMs?: number
  /** Most bytes of body to read. Over it: 413. Default 64 KiB. */
  maxBytes?: number
  /**
   * Overrides where the raw bytes come from. **Almost nobody needs this.**
   *
   * The delivery route declares `rawBody()`, so `@basaltkit/http` hands it the
   * untouched octets on Fastify, Express and Hono alike — that is the whole
   * point of the marker, and it needs no wiring. This hook remains for the one
   * shape it cannot reach: an app that terminates the request somewhere else
   * (a serverless adapter, a proxy that re-frames the body) and holds the real
   * bytes itself.
   *
   * What it is *not* is a place to reconstruct them. Returning
   * `JSON.stringify(request.body)` here re-creates the fail-every-delivery bug
   * this route was built to make impossible: a signature covers the bytes that
   * arrived, and a re-serialised object is a different message. Return the
   * bytes or return nothing — the route **fails closed** with
   * `DRIVE_NOTIFICATION_INVALID` rather than guess.
   */
  rawBody?: (request: HttpRequest) => Buffer | string | undefined
}

export interface DriveRoutesOptions {
  /** Mount prefix. Default `/drives`. */
  basePath?: string
  /**
   * The redirect URI registered with the provider. A function when it differs
   * per provider, which it usually does.
   *
   * It must match the provider's registration byte for byte; it is validated
   * (absolute, `https:` except on localhost, no credentials, no fragment)
   * before it ever reaches a URL the browser follows.
   */
  redirectUri: string | ((provider: string) => string)
  /** Scopes to request, when they differ from the adapter's defaults. */
  scopes?: (provider: string) => readonly string[] | undefined
  /**
   * Where to send the browser after a successful connect. Omit to answer with
   * the connection as JSON — useful for an SPA that opened a popup.
   */
  successRedirect?: string | ((connection: DriveConnectionView) => string)
  /**
   * Guard metadata for the connect and callback routes. Default
   * `{ auth: true }`: starting an authorization on behalf of a tenant is not
   * an anonymous action, and defaulting it open is how a connect endpoint
   * becomes a way to attach an attacker's drive to someone else's tenant.
   *
   * The notification routes never get this — the provider has no session.
   */
  meta?: Record<string, unknown>
  cookie?: {
    name?: string
    /** Force `Secure` off. Only honoured for a `http://localhost` redirect URI. */
    secure?: boolean
    sameSite?: 'Lax' | 'Strict'
  }
  /** Mount the notification endpoint. Omit it and only the connect flow is served. */
  notifications?: DriveNotificationRoutes
  /** The instance to use. Defaults to `DRIVES` from the request's container. */
  drives?: Drives | (() => Drives)
}

const LABEL_MAX = 100

/** Query of the connect route. `label` is shown to humans, so it is sanitised, not trusted. */
const connectQuery = z.object({
  label: z.string().max(LABEL_MAX).optional(),
  rootId: z.string().max(512).optional(),
})

const callbackQuery = z.object({
  code: z.string().max(4096).optional(),
  state: z.string().max(4096).optional(),
  error: z.string().max(256).optional(),
  error_description: z.string().max(512).optional(),
})

/**
 * The connect flow and (optionally) the notification endpoint, as neutral
 * routes.
 *
 * ```ts
 * fastifyPlugin({ routes: driveRoutes({
 *   redirectUri: (provider) => `https://app.example.com/drives/${provider}/callback`,
 *   successRedirect: '/settings/drives',
 *   notifications: {
 *     connections: ({ accountIds }) => db.driveConnections.byAccount('dropbox', accountIds),
 *     onChange: (connections) => Promise.all(connections.map((c) => SyncDrive.dispatch(c))),
 *   },
 * }) })
 * ```
 */
export function driveRoutes(options: DriveRoutesOptions): BasaltRoute[] {
  const basePath = options.basePath ?? DEFAULT_DRIVES_BASE_PATH
  const cookieName = options.cookie?.name ?? DEFAULT_CONNECT_COOKIE
  const meta = options.meta ?? { auth: true }
  const resolve = (): Drives => {
    const configured = options.drives
    if (typeof configured === 'function') return configured()
    if (configured !== undefined) return configured
    return (ctx().container as Container).get(DRIVES)
  }
  const redirectUriFor = (provider: string): string =>
    typeof options.redirectUri === 'function' ? options.redirectUri(provider) : options.redirectUri

  const routes: BasaltRoute[] = [
    route({
      method: 'GET',
      url: `${basePath}/:provider/connect`,
      params: z.object({ provider: z.string() }),
      query: connectQuery,
      meta,
      handler({ params, query, reply }) {
        const drives = resolve()
        const redirectUri = redirectUriFor(params.provider)
        const scopes = options.scopes?.(params.provider)
        const started = drives.startAuthorization({
          provider: params.provider,
          redirectUri,
          ...(scopes ? { scopes } : {}),
        })
        const label = sanitizeLabel(query.label) ?? `${params.provider} drive`
        const cookiePath = `${basePath}/${encodeURIComponent(params.provider)}`
        return reply
          .code(302)
          .header('location', started.url)
          // A consent URL is single-use and carries a state; nothing about this
          // response may be reused from a cache or a shared proxy.
          .header('cache-control', 'no-store')
          .header(
            'set-cookie',
            serializeCookie(cookieName, encodeBinding({ b: started.binding, l: label, r: query.rootId }), {
              path: cookiePath,
              maxAge: 600,
              secure: isSecureRedirect(redirectUri, options.cookie?.secure),
              sameSite: options.cookie?.sameSite ?? 'Lax',
            }),
          )
          .send()
      },
    }),

    route({
      method: 'GET',
      url: `${basePath}/:provider/callback`,
      params: z.object({ provider: z.string() }),
      query: callbackQuery,
      meta,
      async handler({ params, query, request, reply }) {
        const drives = resolve()
        const redirectUri = redirectUriFor(params.provider)
        const cookiePath = `${basePath}/${encodeURIComponent(params.provider)}`
        const clear = serializeCookie(cookieName, '', {
          path: cookiePath,
          maxAge: 0,
          secure: isSecureRedirect(redirectUri, options.cookie?.secure),
          sameSite: options.cookie?.sameSite ?? 'Lax',
        })
        reply.header('cache-control', 'no-store').header('set-cookie', clear)

        if (query.error !== undefined) {
          // The user declined, or the provider refused. `error_description` is
          // vendor text echoed into our own error message, so it is not
          // forwarded — only the machine-readable code, which is a fixed
          // vocabulary.
          throw new DriveAuthorizationInvalidError(`the provider returned "${query.error}".`)
        }
        const cookie = decodeBinding(readCookie(request, cookieName))
        const connection = await drives.completeAuthorization({
          provider: params.provider,
          code: query.code ?? '',
          redirectUri,
          state: query.state,
          binding: cookie?.b,
          label: cookie?.l ?? `${params.provider} drive`,
          ...(cookie?.r !== undefined ? { rootId: cookie.r } : {}),
        })

        const target =
          typeof options.successRedirect === 'function'
            ? options.successRedirect(connection)
            : options.successRedirect
        if (target === undefined) return reply.code(200).send(connection)
        return reply.code(302).header('location', target).send()
      },
    }),
  ]

  if (options.notifications) routes.push(...notificationRoutes(basePath, resolve, options.notifications))
  return routes
}

/**
 * The single neutral notification endpoint, as a `GET` (handshake) and a `POST`
 * (delivery).
 *
 * Split into two route definitions rather than one multi-method route because
 * `route()` takes one method — and because the two have genuinely different
 * contracts: the `GET` answers before any connection exists and must not read a
 * body, the `POST` must read the raw body and nothing else.
 */
function notificationRoutes(
  basePath: string,
  resolve: () => Drives,
  options: DriveNotificationRoutes,
): BasaltRoute[] {
  const maxBytes = options.maxBytes ?? DEFAULT_NOTIFICATION_MAX_BYTES

  /**
   * Verifies, then schedules. The `onChange` callback is the only side effect
   * this endpoint has, and it is reached only for a notification that verified
   * *and* matched a connection we already hold.
   */
  const receive = async (provider: string, input: DriveNotificationInput): Promise<string | undefined> => {
    const drives = resolve()
    const candidates = options.connections
    // Always wrapped, array or resolver alike, so `onChange` is told the same
    // authenticated query either way — an app should not get a different
    // `accountIds` depending on how it happened to supply its candidates.
    let asked: DriveNotificationQuery = { provider }
    const outcome = await handleNotification(drives, input, {
      provider,
      connections: async (query) => {
        asked = query
        return typeof candidates === 'function' ? candidates(query) : candidates
      },
      ...(options.replayGuard ? { replayGuard: options.replayGuard } : {}),
      ...(options.replayTtlMs !== undefined ? { replayTtlMs: options.replayTtlMs } : {}),
    })
    if (outcome.challenge !== undefined) return outcome.challenge
    if (outcome.shouldSync) await options.onChange(outcome.connections, asked)
    return undefined
  }

  /**
   * A handshake that lives entirely in the query, answered before any body is
   * read — or `undefined` for anything that is not one.
   *
   * This exists for Microsoft Graph, whose subscription validation is a POST
   * carrying `?validationToken=` and **no body at all**. Dropbox's arrives on
   * GET and Graph's on POST; one route answers both, and neither may depend on
   * a body being available, because neither sends one.
   *
   * Three properties it must keep, all of which the shape below is chosen for:
   *
   * - **It never consults a connection.** `connections` resolves to nothing, so
   *   a probe cannot match, fan out or schedule a sync — and the answer is the
   *   same whether or not this deployment holds any account at all. (The
   *   challenge short-circuits inside `handleNotification` before candidates are
   *   even asked for; the empty resolver is the belt to that braces.)
   * - **It never consumes a replay token.** The replay guard is deliberately not
   *   passed: a handshake is not a delivery, and spending the delivery's token
   *   on it would make the real notification look like a replay.
   * - **It cannot turn a bad delivery into a 200.** It only ever returns a
   *   challenge. A verification failure is swallowed *here* so the real path can
   *   read the bytes and raise it properly, with the message that fits.
   */
  const challengeFromQuery = async (provider: string, request: HttpRequest): Promise<string | undefined> => {
    const query = queryOf(request)
    // No query, no handshake to find — and no reason to verify twice.
    if (Object.keys(query).length === 0) return undefined
    try {
      const outcome = await handleNotification(
        resolve(),
        { method: 'POST', headers: headersOf(request), query, body: EMPTY_BODY },
        { provider, connections: () => [] },
      )
      return outcome.challenge
    } catch {
      // Not a handshake. The delivery path decides what this really is.
      return undefined
    }
  }

  return [
    route({
      method: 'GET',
      url: `${basePath}/:provider/notifications`,
      params: z.object({ provider: z.string() }),
      async handler({ params, request, reply }) {
        const challenge = await receive(params.provider, {
          method: 'GET',
          headers: headersOf(request),
          query: queryOf(request),
          // A handshake has no body, and reading one would be the only way a
          // GET to this endpoint could cost anything.
          body: Buffer.alloc(0),
        })
        if (challenge === undefined) {
          // Nothing but a handshake is legitimate on GET: a verified delivery
          // arrives as a POST for all three vendors.
          throw new DriveNotificationInvalidError('this endpoint answers handshakes on GET.')
        }
        return echo(reply, challenge)
      },
    }),

    route({
      method: 'POST',
      url: `${basePath}/:provider/notifications`,
      params: z.object({ provider: z.string() }),
      // The bytes are the message, and a parsed object cannot be un-parsed:
      // `rawBody()` is what stops any adapter from parsing this one, on all
      // three, and caps what an unauthenticated endpoint will read.
      body: rawBody({ maxBytes }),
      async handler({ body: raw, params, request, reply }) {
        // Microsoft Graph validates a subscription URL with a POST whose token
        // is in the QUERY and whose body is empty — it is sent *before* the
        // subscription exists, so there is nothing to sign. Asking for the
        // bytes first turns that handshake into a refusal, and the operator
        // sees `subscriptionValidationFailed` on `watch()`, which points at the
        // subscription instead of at whatever consumed the body. So the
        // handshake is answered first, and nothing else changes: a POST that is
        // not one still requires the bytes it was signed over.
        const handshake = await challengeFromQuery(params.provider, request)
        if (handshake !== undefined) return echo(reply, handshake)

        const body = notificationBytes(raw, request, options.rawBody, maxBytes)
        const challenge = await receive(params.provider, {
          method: 'POST',
          headers: headersOf(request),
          query: queryOf(request),
          body,
        })
        // A provider that carries its handshake in the body rather than the
        // query still lands here, and is echoed the same way.
        if (challenge !== undefined) return echo(reply, challenge)
        // Identical for a match, a fan-out, another tenant's account and no
        // match at all: the response must not say which happened.
        return reply.code(200).header('cache-control', 'no-store').send({ received: true })
      },
    }),
  ]
}

/** A body with no bytes — what a handshake carries, on every vendor that sends one. */
const EMPTY_BODY = Buffer.alloc(0)

/**
 * Most characters of a handshake token that will be echoed.
 *
 * Every real one is far shorter — Dropbox sends a short random string, Graph a
 * token well under this — so the cap is lossless for a genuine handshake and
 * bounds what an unauthenticated caller can make this endpoint reflect.
 */
const MAX_CHALLENGE_CHARS = 256

/** Control characters and bidi overrides: never in a real token, and dangerous in a log or a terminal. */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHALLENGE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/**
 * Answers a provider handshake: inert, bounded, and not cacheable.
 *
 * The token is attacker-chosen text reflected back from an endpoint that has
 * no authentication by construction, so three things carry the weight:
 * `text/plain` with `nosniff`, which stops a browser talked into visiting the
 * URL from deciding the echo is HTML and running it on this origin; a length
 * cap; and the removal of control and bidi characters, which a real token never
 * contains and which turn a reflected value into a problem wherever it is later
 * read.
 */
function echo(reply: HttpReply, challenge: string): unknown {
  return reply
    .code(200)
    .header('content-type', 'text/plain; charset=utf-8')
    .header('x-content-type-options', 'nosniff')
    .header('cache-control', 'no-store')
    .send(challenge.replace(UNSAFE_CHALLENGE, '').slice(0, MAX_CHALLENGE_CHARS))
}

/**
 * The bytes of a notification, or a refusal.
 *
 * Normally this is just `body.bytes` — `rawBody()` already delivered the
 * octets the pipeline read, on whichever adapter is serving. The explicit
 * resolver wins when an app supplies one, for the deployments that terminate
 * the request somewhere the neutral layer cannot see.
 *
 * What remains deliberately absent is any path back to `request.body`:
 * reconstructing the message by re-serialising a parsed object produces
 * different bytes, so it can only make a correct signature look wrong or — in
 * a route that shrugged that off — make every signature look right.
 */
export function notificationBytes(
  body: unknown,
  request: HttpRequest,
  resolver: ((request: HttpRequest) => Buffer | string | undefined) | undefined,
  maxBytes: number,
): Buffer {
  const bytes = firstBytes([resolver?.(request), rawBytesOf(body)])
  if (bytes === undefined) {
    throw new DriveNotificationInvalidError(
      'the raw request body was not available for this request.',
    )
  }
  if (bytes.length > maxBytes) throw new DriveNotificationInvalidError('the notification body is too large.')
  return bytes
}

/** The octets `rawBody()` handed the handler, when that is what arrived. */
const rawBytesOf = (body: unknown): Buffer | undefined => {
  const bytes = (body as RawBody | undefined)?.bytes
  return Buffer.isBuffer(bytes) ? bytes : undefined
}

const firstBytes = (candidates: readonly unknown[]): Buffer | undefined => {
  for (const candidate of candidates) {
    if (Buffer.isBuffer(candidate)) return candidate
    if (typeof candidate === 'string') return Buffer.from(candidate, 'utf8')
  }
  return undefined
}

/** Lower-cased, single-valued headers — what `verifyNotification` is specified against. */
function headersOf(request: HttpRequest): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(request.headers)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value[0] : value
  }
  return out
}

/** The query as flat strings, whatever the adapter produced. */
function queryOf(request: HttpRequest): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  const source = request.query
  if (source !== null && typeof source === 'object') {
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value
      else if (Array.isArray(value) && typeof value[0] === 'string') out[key] = value[0] as string
    }
  }
  return out
}

/** A display label the app will render. Control characters and bidi overrides stripped. */
function sanitizeLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim()
  return cleaned === '' ? undefined : cleaned.slice(0, LABEL_MAX)
}

interface ConnectCookie {
  /** The browser binding the authorization is tied to. */
  b: string
  /** Label chosen when the flow started. */
  l: string
  /** Root folder chosen when the flow started. */
  r?: string | undefined
}

/**
 * The cookie carries the binding and the choices made when the flow started.
 *
 * It is not signed, and does not need to be: the **binding** is the security
 * value, and it is verified against the signed `state` (which the app secret
 * covers) at the callback. Tampering with `label` or `rootId` changes only what
 * the same user is creating for themselves, in their own tenant, in a flow they
 * started.
 */
function encodeBinding(cookie: ConnectCookie): string {
  return Buffer.from(JSON.stringify(cookie), 'utf8').toString('base64url')
}

function decodeBinding(value: string | undefined): ConnectCookie | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as ConnectCookie
    return typeof parsed?.b === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Reads one cookie out of the request, without a cookie-parser dependency. */
export function readCookie(request: HttpRequest, name: string): string | undefined {
  const header = request.headers['cookie']
  const raw = Array.isArray(header) ? header.join('; ') : header
  if (typeof raw !== 'string') return undefined
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      return part.slice(eq + 1).trim()
    }
  }
  return undefined
}

function serializeCookie(
  name: string,
  value: string,
  options: { path: string; maxAge: number; secure: boolean; sameSite: 'Lax' | 'Strict' },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAge}`,
    // HttpOnly is the whole point: the binding must not be readable by script,
    // or an XSS anywhere on the origin completes someone else's drive connect.
    'HttpOnly',
    `SameSite=${options.sameSite}`,
  ]
  if (options.secure) parts.push('Secure')
  return parts.join('; ')
}

/**
 * `Secure` unless the redirect URI is a localhost development one.
 *
 * An explicit `secure: false` is honoured only there: a cookie that binds an
 * OAuth flow must not travel in clear on a real deployment because a config
 * flag said so.
 */
function isSecureRedirect(redirectUri: string, override: boolean | undefined): boolean {
  let local = false
  try {
    const url = new URL(redirectUri)
    local = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
  } catch {
    local = false
  }
  if (!local) return true
  return override ?? false
}
