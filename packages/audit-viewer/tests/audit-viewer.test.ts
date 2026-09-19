import { describe, expect, it } from 'vitest'
import { BasaltError, createApp, definePlugin, ensureMetadata, runWithContext } from '@basaltkit/core'
import { Audit, MemoryAuditStore, auditPlugin, type AuditEntry } from '@basaltkit/audit'
import { FASTIFY, fastifyPlugin } from '@basaltkit/fastify'
import { MemoryUserSource, authPlugin, authRoutes } from '@basaltkit/auth'
import { MemoryTenantSource, headerResolver, tenancyPlugin } from '@basaltkit/tenancy'
import { AUDIT_VIEWER, AuditTenantMismatchError, AuditTenantRequiredError, AuditViewer, AuditViewerUnguardedError, auditViewerCsp, auditViewerHtml, auditViewerPlugin, auditViewerRoutes } from '../src/index.js'

let counter = 0
const entry = (over: Partial<AuditEntry> & { event: string }): AuditEntry => ({
  id: over.id ?? `e${++counter}`,
  source: over.source ?? 'event',
  event: over.event,
  payload: over.payload ?? {},
  tenantId: over.tenantId ?? 'acme',
  actorId: over.actorId,
  requestId: undefined,
  at: over.at ?? counter * 1000,
})

async function seededStore(): Promise<MemoryAuditStore> {
  const store = new MemoryAuditStore()
  const entries: AuditEntry[] = [
    entry({ id: 'e1', event: 'auth:login', actorId: 'u1', source: 'hook', at: 1000 }),
    entry({ id: 'e2', event: 'auth:logout', actorId: 'u1', source: 'hook', at: 2000 }),
    entry({ id: 'e3', event: 'order:created', actorId: 'u2', source: 'event', at: 3000 }),
    entry({ id: 'e4', event: 'auth:login', actorId: 'u2', source: 'hook', at: 4000 }),
    entry({ id: 'e5', event: 'secret:read', actorId: 'u9', tenantId: 'globex', at: 5000 }),
  ]
  for (const e of entries) await store.append(e)
  return store
}

const viewerFor = async () => new AuditViewer(new Audit(await seededStore()), { bucketMs: 1000 })

describe('AuditViewer', () => {
  it('pages tenant entries, newest first, with totals', async () => {
    const viewer = await viewerFor()
    const page = await viewer.page({ tenantId: 'acme' })
    expect(page.total).toBe(4) // globex excluded
    expect(page.entries[0]!.event).toBe('auth:login') // the at:4000 one (newest)
    expect(page.entries[0]!.at).toBe(4000)

    const second = await viewer.page({ tenantId: 'acme', limit: 2, offset: 2 })
    expect(second.entries).toHaveLength(2)
    expect(second.total).toBe(4)
  })

  it('filters by event pattern, actor and source', async () => {
    const viewer = await viewerFor()
    expect((await viewer.page({ tenantId: 'acme', event: 'auth:**' })).total).toBe(3)
    expect((await viewer.page({ tenantId: 'acme', actorId: 'u1' })).total).toBe(2)
    expect((await viewer.page({ tenantId: 'acme', source: 'event' })).total).toBe(1)
    expect((await viewer.page({ tenantId: 'acme', until: 2000 })).total).toBe(2)
  })

  it('aggregates stats', async () => {
    const viewer = await viewerFor()
    const stats = await viewer.stats({ tenantId: 'acme' })
    expect(stats.total).toBe(4)
    expect(stats.byEvent.find((e) => e.event === 'auth:login')?.count).toBe(2)
    expect(stats.byActor.find((a) => a.actorId === 'u1')?.count).toBe(2)
    expect(stats.bySource).toMatchObject({ hook: 3, event: 1 })
    expect(stats.timeline.length).toBeGreaterThan(0)
  })

  it('gets one entry and resolves the tenant from context', async () => {
    const viewer = await viewerFor()
    expect((await viewer.get('e1', 'acme'))?.event).toBe('auth:login')
    expect(await viewer.get('missing', 'acme')).toBeNull()

    const page = await runWithContext({ tenant: { id: 'acme' } } as never, () => viewer.page())
    expect(page.total).toBe(4)
    // In a MULTI-TENANT app an unscoped read is still refused.
    const multiTenant = new AuditViewer(new Audit(await seededStore()), { bucketMs: 1000 }, () => true)
    await expect(multiTenant.page()).rejects.toBeInstanceOf(AuditTenantRequiredError)
  })
})

describe('beyond-SaaS: the viewer does not require tenancy', () => {
  /** Stands in for @basaltkit/tenancy: its only cross-package signal. */
  const fakeTenancyMarker = definePlugin({
    name: 'fake-tenancy-marker',
    register({ container }) {
      ensureMetadata(container).add('tenancy:active', true)
    },
  })

  it('with NO tenancy, page()/stats()/get() read the whole trail instead of throwing', async () => {
    const viewer = new AuditViewer(new Audit(await seededStore()), { bucketMs: 1000 })

    const page = await viewer.page()
    expect(page.total).toBe(5) // every entry, no tenant dimension to scope to
    expect((await viewer.stats()).total).toBe(5)
    expect((await viewer.get('e5'))?.event).toBe('secret:read')
  })

  it('auditViewerPlugin wires the tenancy signal from the container marker', async () => {
    const single = await createApp({ plugins: [auditPlugin(), auditViewerPlugin()] }).boot()
    await single.container.get(AUDIT_VIEWER).page() // must not throw
    await single.shutdown()

    const multi = await createApp({ plugins: [fakeTenancyMarker, auditPlugin(), auditViewerPlugin()] }).boot()
    await expect(multi.container.get(AUDIT_VIEWER).page()).rejects.toBeInstanceOf(AuditTenantRequiredError)
    await multi.shutdown()
  })
})

describe('auditViewerHtml', () => {
  it('renders a self-contained page that calls the audit API', () => {
    const html = auditViewerHtml({ title: 'My Audit' })
    expect(html).toContain('<title>My Audit</title>')
    expect(html).toContain("fetch(API + '/audit?'")
    expect(html).toContain("fetch(API + '/audit/stats?'")
  })
})

describe('HTTP routes', () => {
  it('serves paginated entries, stats and the HTML page for the tenant', async () => {
    const store = await seededStore()
    const app = await createApp({
      plugins: [
        tenancyPlugin({ source: new MemoryTenantSource().add({ id: 'acme' }), resolvers: [headerResolver()] }),
        authPlugin({ users: new MemoryUserSource(), secret: 'test-secret-value-123456', loginThrottle: false }),
        auditPlugin({ store }),
        auditViewerPlugin(),
        fastifyPlugin({ routes: [...authRoutes(), ...auditViewerRoutes({ allowAnyAuthenticated: true })] }),
      ],
    }).boot()
    const server = app.container.get(FASTIFY)

    await server.inject({ method: 'POST', url: '/auth/register', payload: { email: 'admin@acme.test', password: 'password123' } })
    const token = (await server.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@acme.test', password: 'password123' } })).json().accessToken
    const auth = { authorization: `Bearer ${token}`, 'x-tenant-id': 'acme' }

    const list = await server.inject({ method: 'GET', url: '/audit?event=auth:**', headers: auth })
    expect(list.statusCode).toBe(200)
    expect(list.json().total).toBe(3) // the 3 seeded auth entries for acme

    // total is >= the 4 seeded (the viewer's own requests get audited too)
    expect((await server.inject({ method: 'GET', url: '/audit/stats', headers: auth })).json().total).toBeGreaterThanOrEqual(4)

    const page = await server.inject({ method: 'GET', url: '/audit/view', headers: auth })
    expect(page.statusCode).toBe(200)
    expect(page.headers['content-type']).toContain('text/html')

    await app.shutdown()
  })
})

describe('escaping + route-scoped CSP (S-5)', () => {
  it('escapes the title and keeps embedded JSON inside the script block', () => {
    const html = auditViewerHtml({ title: '</title><script>alert(1)</script>', apiBase: '</script><svg>' })
    expect(html).not.toContain('<script>alert(1)')
    expect(html.match(/<\/script>/g)).toHaveLength(1)
  })

  it('the client-side esc helper escapes quotes', () => {
    expect(auditViewerHtml()).toContain(`[&<>"']`)
  })

  it('exports a CSP whose sha256 matches the inline script exactly', async () => {
    const { createHash } = await import('node:crypto')
    const page = auditViewerHtml({ apiBase: '/a' })
    // Plain index extraction (not a sanitizer) — avoids regex-on-HTML patterns.
    const script = page.slice(page.indexOf('<script>') + '<script>'.length, page.indexOf('</scr' + 'ipt>'))
    // CSP script-hash source value (not a credential): sha256 per the CSP spec.
    const cspScriptDigest = createHash('sha256').update(script, 'utf8').digest('base64')
    expect(auditViewerCsp({ apiBase: '/a' })).toContain(`'sha256-${cspScriptDigest}'`)
  })
})

describe('F-5 · the viewer bounds how much of the trail it reads', () => {
  const bulk = async (n: number): Promise<Audit> => {
    const store = new MemoryAuditStore()
    for (let i = 0; i < n; i++) {
      await store.append(entry({ id: `b${i}`, event: 'order:created', tenantId: 'acme', at: i }))
    }
    return new Audit(store)
  }

  it('reads at most maxScan rows and flags the result as truncated', async () => {
    const viewer = new AuditViewer(await bulk(50), { maxScan: 10 })
    const page = await viewer.page({ tenantId: 'acme', limit: 5 })

    expect(page.entries).toHaveLength(5)
    expect(page.total).toBe(10)
    expect(page.truncated).toBe(true)
  })

  it('is not truncated when the trail fits inside the window', async () => {
    const viewer = new AuditViewer(await bulk(5), { maxScan: 10 })
    const page = await viewer.page({ tenantId: 'acme' })

    expect(page.total).toBe(5)
    expect(page.truncated).toBe(false)
  })

  it('flags truncation on stats as well', async () => {
    const viewer = new AuditViewer(await bulk(50), { maxScan: 10 })
    const stats = await viewer.stats({ tenantId: 'acme' })

    expect(stats.total).toBe(10)
    expect(stats.truncated).toBe(true)
  })
})

describe('F38 · auditViewerRoutes() refuse to mount without an authorization guard', () => {
  /** A stand-in for permissions/teams: claims `meta.auditAdmin` and admits only admin@acme.test. */
  const adminGuard = definePlugin({
    name: 'test-admin-guard',
    register({ container }) {
      const metadata = ensureMetadata(container)
      metadata.add('http:guards', (({ route, context }: { route: { meta?: Record<string, unknown> }; context: { user?: { email?: string } } }) => {
        if (route.meta?.['auditAdmin'] === true && context.user?.email !== 'admin@acme.test') {
          throw new (class extends BasaltError {
            readonly status = 403
          })('FORBIDDEN', 'Forbidden')
        }
      }) as never)
      metadata.add('http:guarded-meta', 'auditAdmin')
    },
  })

  it('throws when no guard is given, or the guard is only `auth`', () => {
    expect(() => auditViewerRoutes()).toThrow(AuditViewerUnguardedError)
    expect(() => auditViewerRoutes({ meta: {} })).toThrow(AuditViewerUnguardedError)
    expect(() => auditViewerRoutes({ meta: { auth: true } })).toThrow(AuditViewerUnguardedError)
    expect(() => auditViewerRoutes({ meta: { can: undefined } })).toThrow(AuditViewerUnguardedError)
  })

  it('a guard that enforces nothing does not count: empty/null/false values and non-authorization keys', () => {
    // teamsPlugin skips a falsy `teamRole` (`if (!required) return`), so
    // `{ teamRole: '' }` (e.g. an unset env var) would mount the trail for
    // every logged-in user; `rateLimit`, `central`, `tags`… authorize nobody.
    for (const meta of [
      { teamRole: '' },
      { teamRole: null },
      { teamRole: false },
      { can: [] },
      { scopes: [] },
      { rateLimit: { max: 10, window: '1m' } },
      { central: true },
      { tags: ['audit'], summary: 'Audit' },
      { mcp: true },
      { etag: true },
    ]) {
      expect(() => auditViewerRoutes({ meta }), JSON.stringify(meta)).toThrow(AuditViewerUnguardedError)
    }
    // A real guard next to such keys still counts.
    expect(() => auditViewerRoutes({ meta: { teamRole: 'admin', rateLimit: { max: 10 } } })).not.toThrow()
  })

  it('merges the guard into every route and keeps auth required', () => {
    const routes = auditViewerRoutes({ meta: { can: 'audit:read', auth: false } })
    expect(routes).toHaveLength(4)
    for (const r of routes) expect(r.meta).toEqual({ can: 'audit:read', auth: true })
  })

  it('allowAnyAuthenticated is the explicit opt-out', () => {
    for (const r of auditViewerRoutes({ allowAnyAuthenticated: true })) expect(r.meta).toEqual({ auth: true })
  })

  it('a self-registered user without the guard role cannot read other users’ audit entries', async () => {
    const store = await seededStore()
    const app = await createApp({
      plugins: [
        tenancyPlugin({ source: new MemoryTenantSource().add({ id: 'acme' }), resolvers: [headerResolver()] }),
        authPlugin({ users: new MemoryUserSource(), secret: 'test-secret-value-123456', loginThrottle: false }),
        adminGuard,
        auditPlugin({ store }),
        auditViewerPlugin(),
        fastifyPlugin({ routes: [...authRoutes(), ...auditViewerRoutes({ meta: { auditAdmin: true } })] }),
      ],
    }).boot()
    const server = app.container.get(FASTIFY)
    const tokenFor = async (email: string) => {
      await server.inject({ method: 'POST', url: '/auth/register', payload: { email, password: 'password123' } })
      return (await server.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'password123' } })).json()
        .accessToken as string
    }
    const mallory = { authorization: `Bearer ${await tokenFor('mallory@evil.test')}`, 'x-tenant-id': 'acme' }
    const admin = { authorization: `Bearer ${await tokenFor('admin@acme.test')}`, 'x-tenant-id': 'acme' }

    for (const url of ['/audit?limit=100', '/audit/stats', '/audit/e1', '/audit/view']) {
      expect((await server.inject({ method: 'GET', url, headers: mallory })).statusCode).toBe(403)
    }
    expect((await server.inject({ method: 'GET', url: '/audit?event=auth:**', headers: admin })).statusCode).toBe(200)
    await app.shutdown()
  })
})

describe('F59 · an explicit tenantId never widens past the context tenant', () => {
  it('refuses a tenantId that differs from the ambient tenant', async () => {
    const viewer = new AuditViewer(new Audit(await seededStore()), {}, () => true)
    const inAcme = <T>(fn: () => Promise<T>) => runWithContext({ tenant: { id: 'acme' } } as never, async () => fn())
    await expect(inAcme(() => viewer.page({ tenantId: 'globex' }))).rejects.toBeInstanceOf(AuditTenantMismatchError)
    await expect(inAcme(() => viewer.stats({ tenantId: 'globex' }))).rejects.toBeInstanceOf(AuditTenantMismatchError)
    await expect(inAcme(() => viewer.get('e5', 'globex'))).rejects.toBeInstanceOf(AuditTenantMismatchError)
    expect((await inAcme(() => viewer.page({ tenantId: 'acme' }))).total).toBe(4)
  })
})
