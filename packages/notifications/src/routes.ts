import { BasaltError, tryCtx, type Container } from '@basaltkit/core'
import { route, type BasaltRoute } from '@basaltkit/http'
import { z } from 'zod'
import { IN_APP } from './tokens.js'

/**
 * Reading your own in-app notifications.
 *
 * The package stored these and never served them, so a bell icon had nowhere to
 * read from and every application wrote the same four endpoints.
 *
 * The routing shape is opinionated enough that leaving it out was defensible.
 * The **security** decision is not, and is the same everywhere: **the recipient
 * is the session, never a parameter.** No handler here reads an id from the
 * query or the body — a `?recipientId=` is the shortest path to one employee
 * reading another's alerts, and a deadline alert names the case.
 *
 * ```ts
 * fastifyPlugin({ routes: [...inAppRoutes(), ...myRoutes] })
 * ```
 */
export class NotificationNotFoundError extends BasaltError {
  readonly status = 404
  constructor() {
    // 404 and not 403: confirming someone else's notification exists would
    // already say something about it.
    super('NOTIFICATION_NOT_FOUND', 'Notification not found.')
  }
}

class AuthRequiredError extends BasaltError {
  readonly status = 401
  constructor() {
    super('UNAUTHENTICATED', 'Sign in to read your notifications.')
  }
}

const recipient = (): string => {
  const user = tryCtx()?.['user'] as { id: string } | undefined
  if (!user?.id) throw new AuthRequiredError()
  return user.id
}

const store = () => {
  const container = tryCtx()?.['container'] as Container | undefined
  if (!container) throw new AuthRequiredError()
  return container.get(IN_APP)
}

export interface InAppRoutesOptions {
  /** Path prefix. Default `/me/notifications`. */
  prefix?: string
  /** How many a listing returns without `limit`. Default 30. */
  defaultLimit?: number
}

export function inAppRoutes(options: InAppRoutesOptions = {}): BasaltRoute[] {
  const prefix = options.prefix ?? '/me/notifications'
  const defaultLimit = options.defaultLimit ?? 30

  return [
    route({
      method: 'GET',
      url: prefix,
      meta: { auth: true },
      query: z.object({
        unreadOnly: z.coerce.boolean().optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
      async handler({ query }) {
        return store().list(recipient(), {
          ...(query?.unreadOnly === undefined ? {} : { unreadOnly: query.unreadOnly }),
          limit: query?.limit ?? defaultLimit,
        })
      },
    }),

    route({
      method: 'GET',
      url: `${prefix}/unread-count`,
      meta: { auth: true },
      async handler() {
        return { count: await store().unreadCount(recipient()) }
      },
    }),

    route({
      method: 'POST',
      url: `${prefix}/:id/read`,
      meta: { auth: true },
      params: z.object({ id: z.string() }),
      async handler({ params }) {
        // `markRead` takes the recipient, so marking someone else's returns
        // false rather than succeeding — the store enforces it too.
        if (!(await store().markRead(recipient(), params.id))) throw new NotificationNotFoundError()
        return { ok: true }
      },
    }),

    route({
      method: 'POST',
      url: `${prefix}/read-all`,
      meta: { auth: true },
      async handler() {
        const me = recipient()
        const s = store()
        const porLer = await s.list(me, { unreadOnly: true, limit: 100 })
        for (const n of porLer) await s.markRead(me, n.id)
        return { marked: porLer.length }
      },
    }),
  ]
}
