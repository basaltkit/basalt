import { describe, expect, it } from 'vitest'
import { describeRoutes, findUnguardedRoutes, type RouteRow } from '../src/index.js'
import * as subpath from '../src/route-table.js'

describe('describeRoutes (BK-025)', () => {
  it('normalises every known guard key and sorts by url then method', () => {
    const rows = describeRoutes([
      {
        method: 'post',
        url: '/projects',
        meta: {
          auth: true,
          can: ['projects:create', { permission: 'projects:own', resource: () => null }],
          rateLimit: { limit: 10, windowMs: 60_000, key: 'user' },
          tenant: true,
        },
      },
      { method: 'GET', url: '/projects', meta: { auth: true, can: 'projects:read' } },
      { method: 'GET', url: '/health', meta: { auth: false } },
      { method: 'GET', url: '/admin', meta: { auth: true, central: true, mfa: true, teamRole: 'admin', can: false } },
      { method: 'GET', url: '/bare' },
    ])
    expect(rows.map((row) => `${row.method} ${row.url}`)).toEqual([
      'GET /admin',
      'GET /bare',
      'GET /health',
      'GET /projects',
      'POST /projects',
    ])
    const [admin, bare, health, list, create] = rows as [RouteRow, RouteRow, RouteRow, RouteRow, RouteRow]
    expect(create).toEqual({
      method: 'POST',
      url: '/projects',
      auth: true,
      can: ['projects:create', 'projects:own'],
      rateLimit: '10/1m per user',
      tenant: 'required',
      public: false,
      guards: [],
    })
    expect(list.can).toEqual(['projects:read'])
    expect(health).toMatchObject({ auth: false, public: true, can: null })
    expect(admin).toMatchObject({ tenant: 'central', can: [], guards: ['mfa', 'teamRole=admin'] })
    expect(bare).toEqual({
      method: 'GET',
      url: '/bare',
      auth: null,
      can: null,
      rateLimit: null,
      tenant: null,
      public: false,
      guards: [],
    })
  })

  it('formats rate-limit windows and keys', () => {
    const rate = (rateLimit: unknown) => describeRoutes([{ method: 'GET', url: '/', meta: { rateLimit } }])[0]?.rateLimit
    expect(rate({ limit: 5, windowMs: 1_000 })).toBe('5/1s')
    expect(rate({ limit: 5, windowMs: 3_600_000, key: 'ip' })).toBe('5/1h')
    expect(rate({ limit: 5, windowMs: 1_500, key: () => 'x' })).toBe('5/1500ms per custom key')
    expect(rate({ limit: '5' })).toBeNull()
  })

  it('formats several budgets and shared buckets', () => {
    const rate = (rateLimit: unknown) => describeRoutes([{ method: 'GET', url: '/', meta: { rateLimit } }])[0]?.rateLimit
    expect(
      rate([
        { limit: 10, windowMs: 1_000, key: 'apiKey' },
        { limit: 50_000, windowMs: 86_400_000, key: 'tenant', bucket: 'public-api-daily' },
      ]),
    ).toBe('10/1s per apiKey, 50000/24h per tenant [public-api-daily]')
    expect(rate({ limit: 5, windowMs: 60_000, bucket: 'shared' })).toBe('5/1m [shared]')
    expect(rate([{ limit: 'x' }, { limit: 1, windowMs: 1_000 }])).toBe('1/1s')
    expect(rate([])).toBeNull()
  })

  it('marks meta.tenant: false as exempt and meta.public as public', () => {
    const [row] = describeRoutes([{ method: 'GET', url: '/pricing', meta: { tenant: false, public: true } }])
    expect(row).toMatchObject({ tenant: 'exempt', public: true, auth: null })
  })

  it('is available from the zod-free subpath', () => {
    expect(subpath.describeRoutes).toBe(describeRoutes)
  })
})

describe('findUnguardedRoutes (BK-025)', () => {
  const rows = describeRoutes([
    { method: 'GET', url: '/health', meta: { auth: false } },
    { method: 'GET', url: '/me', meta: { auth: true } },
    { method: 'GET', url: '/projects', meta: { auth: true, can: 'projects:read' } },
    { method: 'POST', url: '/webhooks/stripe' },
    { method: 'GET', url: '/reports', meta: { can: 'reports:read' } },
    { method: 'GET', url: '/settings', meta: { auth: true, can: false } },
  ])

  it('reports routes missing a required guard and skips explicit opt-outs', () => {
    const offenders = findUnguardedRoutes(rows, { require: ['auth', 'can'] })
    expect(offenders.map(({ row, missing }) => [`${row.method} ${row.url}`, missing])).toEqual([
      ['GET /me', ['can']],
      ['GET /reports', ['auth']],
      ['POST /webhooks/stripe', ['auth', 'can']],
    ])
  })

  it('only checks what was required', () => {
    expect(findUnguardedRoutes(rows, { require: ['auth'] }).map(({ row }) => row.url)).toEqual([
      '/reports',
      '/webhooks/stripe',
    ])
    expect(findUnguardedRoutes(rows, { require: [] })).toEqual([])
  })

  it('counts only auth: true as auth — the one value authPlugin enforces', () => {
    const odd = describeRoutes([
      { method: 'GET', url: '/a', meta: { auth: 'session', can: 'x' } },
      { method: 'GET', url: '/b', meta: { auth: { strategy: 'jwt' }, can: 'x' } },
    ])
    expect(odd.map((row) => row.auth)).toEqual(['session', '{"strategy":"jwt"}'])
    expect(findUnguardedRoutes(odd, { require: ['auth'] }).map(({ row, missing }) => [row.url, missing])).toEqual([
      ['/a', ['auth']],
      ['/b', ['auth']],
    ])
  })

  it('honours the allow predicate', () => {
    const offenders = findUnguardedRoutes(rows, {
      require: ['auth'],
      allow: (row) => row.url.startsWith('/webhooks/'),
    })
    expect(offenders.map(({ row }) => row.url)).toEqual(['/reports'])
  })
})
