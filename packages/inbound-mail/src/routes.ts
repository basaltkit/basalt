import { createHash } from 'node:crypto'
import type { HookBus } from '@basaltkit/core'
import { HttpError, internalDetailsOf, rawBody, route, type BasaltRoute } from '@basaltkit/http'
import type { InboundMail, InboundMailDriver } from './contract.js'
import { InboundMailMalformedError } from './errors.js'
import { parseInbound, type ParsedInboundMail, type ParseInboundOptions } from './parse.js'
import { compileAddressPattern, type InboundAddressPattern, type InboundRouteMatch } from './routing.js'

/** Why a delivery was refused, as the `inbound-mail:rejected` hook reports it. */
export type InboundRejectedReason = 'unauthorized' | 'malformed' | 'unsupported-type' | 'too-large' | 'error'

declare module '@basaltkit/core' {
  interface BasaltHooks {
    /** A delivery was refused before routing. Carries no address and no content. */
    'inbound-mail:rejected': { reason: InboundRejectedReason; source: string; detail?: string; digest: string }
    /** An authenticated delivery matched no route. Carries no address and no content. */
    'inbound-mail:unrouted': { source: string; digest: string }
  }
}

/** What a route handler receives. */
export interface InboundMailContext {
  mail: InboundMail
  match: InboundRouteMatch
  /**
   * Parses `mail.raw` with the routes' `parse` options. Memoised. Throws
   * `InboundMailMalformedError` (400) for an oversize notice, which has no
   * message to parse, and `InboundMailLimitError` (422) over a limit.
   */
  parse(): Promise<ParsedInboundMail>
}

export interface InboundMailRoute {
  /** `'invoices@in.example.com'`, `'{tenant}@in.example.com'`, or a predicate. Case-insensitive; `+tag` split off first. */
  address: InboundAddressPattern
  handler(ctx: InboundMailContext): Promise<void> | void
}

export interface InboundMailRoutesOptions {
  driver: InboundMailDriver
  /** Tried in order; the first match wins. Must not be empty. */
  routes: readonly InboundMailRoute[]
  /** The path. Default `'/inbound/mail'`. */
  url?: string
  /** Options for `ctx.parse()`: limits and the Authentication-Results/ARC trust lists. */
  parse?: ParseInboundOptions
  /** Route metadata, merged over `{ auth: false }` (the signature is the authentication). Put `rateLimit` here. */
  meta?: Record<string, unknown>
  /** Called when no route matches. The response is the same 200 either way. */
  onUnrouted?: (address: string, mail: InboundMail) => Promise<void> | void
  /** Receives `inbound-mail:rejected` and `inbound-mail:unrouted`. */
  hooks?: HookBus
}

/** The first 8 hex characters of the body's sha256: enough to correlate log lines, never the content. */
const digestOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex').slice(0, 8)

function rejectedReasonOf(error: unknown): InboundRejectedReason {
  if (!(error instanceof HttpError)) return 'error'
  if (error.status === 401) return 'unauthorized'
  if (error.status === 415) return 'unsupported-type'
  if (error.status === 413) return 'too-large'
  if (error.status === 400) return 'malformed'
  return 'error'
}

/**
 * The route that receives mail: `POST url` with a `rawBody()` body capped at
 * the driver's `maxRequestBytes`. It runs unchanged on Fastify, Express and Hono.
 *
 * 1. The driver authenticates the delivery (415, 400 or 401 otherwise, and the
 *    `inbound-mail:rejected` hook).
 * 2. The signed recipient is matched against `routes` in order. No match calls
 *    `onUnrouted`, emits `inbound-mail:unrouted` and answers 200 with the same
 *    body as a routed delivery, so the endpoint is not an address oracle.
 * 3. The handler runs. A throw is a 500 and the relay retries; a parse limit
 *    is a 422, which is permanent. Handlers must be idempotent on
 *    `ctx.mail.deliveryKey`: there is no built-in dedupe.
 *
 * The package never resolves a tenant: the handler checks that the tenant in
 * `ctx.match.params` exists, then enters it with `tenancy.run`.
 */
export function inboundMailRoutes(options: InboundMailRoutesOptions): BasaltRoute[] {
  const { driver, hooks } = options
  if (!driver || typeof driver.receive !== 'function') {
    throw new TypeError('inboundMailRoutes(): `driver` is required.')
  }
  if (!Array.isArray(options.routes) || options.routes.length === 0) {
    throw new TypeError('inboundMailRoutes(): at least one route is required.')
  }
  const table = options.routes.map((entry) => {
    if (typeof entry?.handler !== 'function') throw new TypeError('inboundMailRoutes(): every route needs a handler.')
    return { match: compileAddressPattern(entry.address), handler: entry.handler }
  })
  const parseOptions = options.parse ?? {}
  const url = options.url ?? '/inbound/mail'

  const accepted = { accepted: true } as const

  return [
    route({
      method: 'POST',
      url,
      // The bytes are the message and the signature covers them: no adapter
      // may parse this body, and the cap bounds what an unauthenticated caller
      // can make the process hold.
      body: rawBody({ maxBytes: driver.maxRequestBytes }),
      meta: { auth: false, ...options.meta },
      async handler({ body, request, reply }) {
        let mail: InboundMail
        try {
          mail = await driver.receive({ body, headers: request.headers })
        } catch (error) {
          const detail = internalDetailsOf(error as Error)?.['reason']
          try {
            await hooks?.emit('inbound-mail:rejected', {
              reason: rejectedReasonOf(error),
              source: driver.name,
              ...(typeof detail === 'string' ? { detail } : {}),
              digest: digestOf(body.bytes),
            })
          } catch {
            // An observer failing must not turn a refusal into a 500 that the
            // relay would retry forever: the refusal is the answer.
          }
          throw error
        }

        const recipient = mail.envelope.to
        let found: { match: InboundRouteMatch; handler: InboundMailRoute['handler'] } | undefined
        for (const entry of table) {
          const match = entry.match(recipient)
          if (match) {
            found = { match, handler: entry.handler }
            break
          }
        }

        if (!found) {
          await options.onUnrouted?.(recipient, mail)
          await hooks?.emit('inbound-mail:unrouted', { source: mail.source, digest: digestOf(mail.raw) })
          return reply.code(200).header('cache-control', 'no-store').send(accepted)
        }

        let parsed: Promise<ParsedInboundMail> | undefined
        await found.handler({
          mail,
          match: found.match,
          parse() {
            if (mail.oversize !== undefined) {
              return Promise.reject(
                new InboundMailMalformedError('This delivery is an oversize notice and carries no message to parse.', 'oversize'),
              )
            }
            parsed ??= parseInbound(mail.raw, parseOptions)
            return parsed
          },
        })
        return reply.code(200).header('cache-control', 'no-store').send(accepted)
      },
    }),
  ]
}
