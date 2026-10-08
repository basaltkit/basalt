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
  /**
   * Extra route metadata merged into every route — a rate limit, an OpenAPI
   * tag, a guard such as `{ can: 'notifications:read' }`. `auth: true` is
   * always applied on top and cannot be switched off.
   */
  meta?: Record<string, unknown>
}

/** Page size of the read-all fallback for stores without `markAllRead`. */
const READ_ALL_PAGE = 100

export function inAppRoutes(options: InAppRoutesOptions = {}): BasaltRoute[] {
  const prefix = options.prefix ?? '/me/notifications'
  const defaultLimit = options.defaultLimit ?? 30
  const meta = { ...options.meta, auth: true }

  return [
    route({
      method: 'GET',
      url: prefix,
      meta,
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
      meta,
      async handler() {
        return { count: await store().unreadCount(recipient()) }
      },
    }),

    route({
      method: 'POST',
      url: `${prefix}/:id/read`,
      meta,
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
      meta,
      async handler() {
        const me = recipient()
        const s = store()
        if (s.markAllRead) return { marked: await s.markAllRead(me) }
        // Fallback for stores written before `markAllRead`: page through the
        // unread ones. Bounded by the count taken up front (plus one page for
        // notifications that arrive meanwhile), and it stops on a page that
        // marks nothing, so a store that keeps listing rows it will not mark
        // cannot spin forever.
        const pages = Math.ceil((await s.unreadCount(me)) / READ_ALL_PAGE) + 1
        let marked = 0
        for (let page = 0; page < pages; page++) {
          const unread = await s.list(me, { unreadOnly: true, limit: READ_ALL_PAGE })
          let changed = 0
          for (const n of unread) if (await s.markRead(me, n.id)) changed++
          marked += changed
          if (changed === 0 || unread.length < READ_ALL_PAGE) break
        }
        return { marked }
      },
    }),
  ]
}
