import { describe, expect, it } from 'vitest'
import { createApp, ensureMetadata } from '@basaltkit/core'
import { ACTIVITY, activityPlugin } from '@basaltkit/activity'
import { AUDIT, auditPlugin } from '@basaltkit/audit'
import { AUDIT_VIEWER, auditViewerPlugin } from '@basaltkit/audit-viewer'
import { CACHE, cachePlugin } from '@basaltkit/cache'
import { COMMENTS, commentsPlugin } from '@basaltkit/comments'
import { EVENTS, defineEvent, eventsPlugin } from '@basaltkit/events'
import { EXPORTS, defineExport, exportsPlugin } from '@basaltkit/exports'
import { FILES, filesPlugin } from '@basaltkit/files'
import { FLAGS, defineFlags, flagsPlugin } from '@basaltkit/flags'
import { I18N, i18nPlugin } from '@basaltkit/i18n'
import { MAILER, defineMail, mailerPlugin } from '@basaltkit/mailer'
import { NOTIFIER, defineNotification, notificationsPlugin } from '@basaltkit/notifications'
import { GATE, MemoryAccessStore, permissionsPlugin } from '@basaltkit/permissions'
import { QUEUE, defineJob, queuePlugin } from '@basaltkit/queue'
import { SCHEDULER, schedulerPlugin } from '@basaltkit/scheduler'
import { SEARCH, MemorySearchDriver, searchPlugin } from '@basaltkit/search'
import { STORAGE, storagePlugin, type StorageDriver } from '@basaltkit/storage'
import { WEBHOOKS, webhooksPlugin, type WebhookDeliverer } from '@basaltkit/webhooks'
import { z } from 'zod'

/**
 * THE BEYOND-SaaS REGRESSION NET.
 *
 * Basalt's promise (`apps/docs/guide/beyond-saas.md`): the SaaS layer —
 * tenancy, teams, subscriptions — is **opt-in**. Every other package is
 * general-purpose and must work in an app that never registers `tenancyPlugin`.
 *
 * The failure mode this catches is subtle and has shipped before: a package
 * hardens itself against cross-tenant reads by requiring a tenant in context,
 * which in a single-tenant app is *never* there — so the everyday call throws
 * and the developer is pushed onto a "system-only" escape hatch. The tenant
 * hardening is right; making it unconditional is the bug.
 *
 * The rule: a generic package MAY fail closed when `@basaltkit/tenancy` is
 * registered (its `'tenancy:active'` metadata marker), and MUST NOT otherwise.
 *
 * This file boots ONE app with the generic plugins and no tenancy, then runs
 * each package's primary read/write path. Any tenancy-flavoured failure fails
 * the suite. It is the tenancy analogue of `packages/http/tests/adapter-boundary.test.ts`.
 */

class MemoryStorageDriver implements StorageDriver {
  readonly name = 'memory'
  readonly files = new Map<string, Buffer>()
  async put(path: string, content: Buffer | string): Promise<void> {
    this.files.set(path, Buffer.isBuffer(content) ? content : Buffer.from(content))
  }
  async get(path: string): Promise<Buffer> {
    const buffer = this.files.get(path)
    if (!buffer) throw new Error(`not found: ${path}`)
    return buffer
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path)
  }
  async delete(path: string): Promise<boolean> {
    return this.files.delete(path)
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((key) => key.startsWith(prefix))
  }
  async temporaryUrl(path: string, expiresInMs: number): Promise<string> {
    return `memory://${path}?e=${expiresInMs}`
  }
  async disconnect(): Promise<void> {}
}

/** Records deliveries instead of making network calls. */
const collectingDeliverer = (sink: string[]): WebhookDeliverer =>
  ({
    async deliver(endpoint: { url: string }, event: string) {
      sink.push(`${endpoint.url}:${event}`)
      return { endpoint: endpoint.url, event, ok: true, status: 200, attempts: 1 }
    },
  }) as unknown as WebhookDeliverer

const OrderCreated = defineEvent('order.created', z.object({ orderId: z.string() }))

const Welcome = defineMail({
  name: 'welcome',
  subject: () => 'Welcome',
  text: () => 'hello',
})

const Ping = defineNotification({
  name: 'ping',
  channels: ['inApp'],
  via: { inApp: () => ({ title: 'Ping', body: 'pong' }) },
})

const NoopJob = defineJob({
  name: 'beyond-saas.noop',
  async handle() {},
})

const flags = defineFlags({
  betaUi: { default: false },
})

const RowExport = defineExport<{ id: string; name: string }>({
  name: 'rows',
  columns: [
    { header: 'id', value: (row) => row.id },
    { header: 'name', value: (row) => row.name },
  ],
})

/** A representative non-SaaS app: everything generic, no tenancyPlugin. */
async function bootWithoutTenancy() {
  const storageDriver = new MemoryStorageDriver()
  const deliveries: string[] = []

  const app = await createApp({
    plugins: [
      eventsPlugin(),
      cachePlugin({ driver: 'memory' }),
      auditPlugin(),
      auditViewerPlugin(),
      activityPlugin(),
      webhooksPlugin({ deliverer: collectingDeliverer(deliveries) }),
      storagePlugin({ disks: { main: { driver: storageDriver } }, default: 'main' }),
      filesPlugin({ disk: 'main' }),
      commentsPlugin(),
      searchPlugin({ driver: new MemorySearchDriver() }),
      exportsPlugin(),
      flagsPlugin(flags),
      i18nPlugin({ defaultLocale: 'en', locales: { en: { hello: 'Hello' } } }),
      mailerPlugin({ driver: 'memory' }),
      notificationsPlugin(),
      permissionsPlugin({ store: new MemoryAccessStore() }),
      queuePlugin({ jobs: [NoopJob] }),
      schedulerPlugin({ autostart: false }),
    ],
  }).boot()

  return { app, storageDriver, deliveries }
}

/**
 * Any error whose code or message points at tenancy. A generic path that
 * produces one of these in a non-tenant app is the regression this net exists
 * to catch, so we surface it loudly rather than letting a generic `.rejects`
 * assertion hide it.
 */
const TENANCY_FLAVOURED = /tenant|tenancy|systemTrail|CACHE_SCOPE_MISSING/i

function assertNotTenancyFailure(label: string, error: unknown): never {
  const detail = `${String((error as { code?: string } | undefined)?.code ?? '')} ${String(
    (error as { message?: string } | undefined)?.message ?? error,
  )}`
  if (TENANCY_FLAVOURED.test(detail)) {
    throw new Error(
      `beyond-SaaS violation: ${label} requires tenancy in an app with no tenancyPlugin — ${detail.trim()}`,
    )
  }
  throw error instanceof Error ? error : new Error(detail)
}

/** Runs a generic path and re-labels a tenancy failure as a boundary violation. */
async function exercise<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    return assertNotTenancyFailure(label, error)
  }
}

describe('beyond-SaaS: the generic packages work without tenancyPlugin', () => {
  it('exercises every generic package\'s primary read/write path', async () => {
    const { app, storageDriver, deliveries } = await bootWithoutTenancy()
    const c = app.container

    // --- audit: the reference regression. trail() must be the everyday read.
    await exercise('audit.record', () => c.get(AUDIT).record('order.shipped', { orderId: 'o-1' }))
    const trail = await exercise('audit.trail', () => c.get(AUDIT).trail())
    expect(trail.map((entry) => entry.event)).toContain('order.shipped')

    // --- audit-viewer: reads through audit, so it inherits the same rule.
    expect((await exercise('auditViewer.page', () => c.get(AUDIT_VIEWER).page())).total).toBeGreaterThan(0)
    await exercise('auditViewer.stats', () => c.get(AUDIT_VIEWER).stats())

    // --- activity
    await exercise('activity.log', () =>
      c.get(ACTIVITY).in('default').performedOn('order', 'o-1').withProperties({ via: 'test' }).log('shipped'),
    )
    expect(await exercise('activity.query', () => c.get(ACTIVITY).for('order', 'o-1'))).toHaveLength(1)

    // --- webhooks: register / list / dispatch
    await exercise('webhooks.register', () =>
      c.get(WEBHOOKS).register({ url: 'https://example.test/hook', events: ['order.created'], secret: 's' }),
    )
    expect(await exercise('webhooks.list', () => c.get(WEBHOOKS).list())).toHaveLength(1)
    await exercise('webhooks.dispatch', () => c.get(WEBHOOKS).dispatch('order.created', { orderId: 'o-1' }))
    expect(deliveries).toEqual(['https://example.test/hook:order.created'])

    // --- cache: get / put / remember / flush (flush was fail-closed unconditionally)
    await exercise('cache.put', () => c.get(CACHE).put('k', 'v'))
    expect(await exercise('cache.get', () => c.get(CACHE).get('k'))).toBe('v')
    expect(await exercise('cache.remember', () => c.get(CACHE).remember('r', '1m', () => 42))).toBe(42)
    await exercise('cache.flush', () => c.get(CACHE).flush())

    // --- storage
    await exercise('storage.put', () => c.get(STORAGE).disk().put('notes/a.txt', 'hello'))
    expect((await exercise('storage.get', () => c.get(STORAGE).disk().get('notes/a.txt'))).toString()).toBe('hello')

    // --- files: the full upload → read → delete pipeline
    const png = Buffer.from('89504e470d0a1a0a', 'hex')
    const file = await exercise('files.upload', () =>
      c.get(FILES).upload(png, { name: 'a.png', contentType: 'image/png' }),
    )
    expect(await exercise('files.list', () => c.get(FILES).list())).toHaveLength(1)
    expect(await exercise('files.get', () => c.get(FILES).get(file.id))).not.toBeNull()
    await exercise('files.download', () => c.get(FILES).download(file.id))
    await exercise('files.temporaryUrl', () => c.get(FILES).temporaryUrl(file.id, '5m'))
    await exercise('files.delete', () => c.get(FILES).delete(file.id))
    // storage paths stay unprefixed — identical to using the disk directly
    expect(await storageDriver.exists('notes/a.txt')).toBe(true)

    // --- comments
    const thread = await exercise('comments.on', async () => c.get(COMMENTS).on('note', '1'))
    const comment = await exercise('comments.add', () => thread.add({ authorId: 'u1', body: 'hi @u2' }))
    expect(await exercise('comments.list', () => thread.list())).toHaveLength(1)
    await exercise('comments.tree', () => thread.tree())
    await exercise('comments.resolve', () => c.get(COMMENTS).resolve(comment.id, 'u1'))
    await exercise('comments.remove', () => c.get(COMMENTS).remove(comment.id))

    // --- search: index and query must agree on one scope
    await exercise('search.index', () => c.get(SEARCH).index('notes', { id: 'n1', title: 'quick brown fox' }))
    expect((await exercise('search.search', () => c.get(SEARCH).search('notes', 'quick'))).total).toBe(1)
    await exercise('search.remove', () => c.get(SEARCH).remove('notes', 'n1'))

    // --- exports
    const csv = await exercise('exports.run', () =>
      c.get(EXPORTS).run(RowExport, [{ id: '1', name: 'a' }], 'csv'),
    )
    expect(csv.content.toString()).toContain('id')

    // --- events
    await exercise('events.emit', () => c.get(EVENTS).emit(OrderCreated, { orderId: 'o-2' }))

    // --- flags / i18n / permissions / mailer / notifications / queue / scheduler
    expect(await exercise('flags.value', async () => c.get(FLAGS).value('betaUi'))).toBe(false)
    expect(await exercise('i18n.t', async () => c.get(I18N).t('hello'))).toBe('Hello')
    expect(await exercise('permissions.can', () => c.get(GATE).can({ id: 'u1' }, 'orders.read'))).toBe(false)
    await exercise('mailer.send', () => c.get(MAILER).send(Welcome, { to: 'a@b.c', from: 'noreply@b.c' }))
    await exercise('notifications.notify', () => c.get(NOTIFIER).notify({ id: 'u1' }, Ping))
    await exercise('queue.dispatch', () => c.get(QUEUE).dispatch(NoopJob, undefined))
    expect(await exercise('scheduler.list', async () => c.get(SCHEDULER).list())).toEqual([])

    await app.shutdown()
  })

  it('guards the guard: the app really has no tenancy marker', async () => {
    const { app } = await bootWithoutTenancy()
    // If `tenancy:active` ever leaked into this app, every assertion above
    // would be exercising the multi-tenant path and the net would pass for the
    // wrong reason.
    expect(ensureMetadata(app.container).get('tenancy:active')).toEqual([])
    await app.shutdown()
  })
})
