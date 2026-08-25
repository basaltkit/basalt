import { describe, expect, it } from 'vitest'
import { detectProject, hasErrors, memoryReader, runDoctor } from '../src/index.js'

const brokenFiles = {
  'package.json': JSON.stringify({ dependencies: { '@basaltkit/fastify': '^1.0.0', '@basaltkit/prisma': '^1.0.0' } }),
  'src/app.ts': `
    import { fastifyPlugin } from '@basaltkit/fastify'
    import { tenancyPlugin, MemoryTenantSource } from '@basaltkit/tenancy'
    export const app = createApp({ plugins: [
      tenancyPlugin({ source: new MemoryTenantSource() }),
      prismaPlugin({ client: prisma }),
      fastifyPlugin({ routes: [] }),
    ] })
  `,
  'src/server.ts': "const app = await buildApp().boot()\nawait server.listen({ port: 3000 })",
  'src/env.ts': "APP_SECRET: z.string().default('change-me-in-production--'),\nREDIS_URL: z.string().default('redis://localhost:6379'),\nqueuePlugin",
  'prisma/schema.prisma': `
    datasource db { provider = "postgresql" url = env("DATABASE_URL") }
    model Tenant { id String @id }
    model Invoice { id String @id name String }
  `,
}

describe('runDoctor', () => {
  const ctx = detectProject('/proj', memoryReader(brokenFiles))
  const found = runDoctor(ctx)
  const ids = found.map((d) => d.id)

  it('flags the lazy Prisma boot (no $connect)', () => {
    expect(ids).toContain('prisma-lazy-boot')
  })

  it("flags Fastify's logger being off", () => {
    expect(ids).toContain('fastify-logger-off')
  })

  it('flags the insecure APP_SECRET default as an error', () => {
    const secret = found.find((d) => d.id === 'insecure-app-secret')
    expect(secret?.severity).toBe('error')
  })

  it('flags a tenant-scoped app model missing tenantId (Invoice, not Tenant)', () => {
    const tenancy = found.find((d) => d.id === 'tenant-scoping-missing')
    expect(tenancy?.detected).toContain('Invoice')
    expect(tenancy?.detected).not.toContain('Tenant')
  })

  it('flags in-memory sources', () => {
    expect(ids).toContain('memory-sources-in-use')
  })

  it('sorts errors before warnings before info', () => {
    const severities = found.map((d) => d.severity)
    expect(severities).toEqual([...severities].sort((a, b) =>
      ({ error: 0, warning: 1, info: 2 })[a] - ({ error: 0, warning: 1, info: 2 })[b]))
  })

  it('reports errors present via hasErrors', () => {
    expect(hasErrors(found)).toBe(true)
  })

  it('flags a missing securityPlugin', () => {
    expect(ids).toContain('missing-security-plugin')
  })

  it('does NOT flag missing membership without auth (no false positive)', () => {
    expect(ids).not.toContain('missing-tenant-membership')
  })
})

describe('missing-tenant-membership (custodian for F1)', () => {
  const base = {
    'package.json': JSON.stringify({
      dependencies: {
        '@basaltkit/fastify': '^1.0.0',
        '@basaltkit/tenancy': '^1.0.0',
        '@basaltkit/auth': '^1.0.0',
        '@basaltkit/teams': '^1.0.0',
      },
    }),
    'src/env.ts': 'APP_SECRET: secret({ minLength: 32 }),',
  }
  const appWith = (extra: string) => `
    import { securityPlugin, fastifyPlugin } from '@basaltkit/fastify'
    import { tenancyPlugin, headerResolver, MemoryTenantSource } from '@basaltkit/tenancy'
    import { authPlugin, MemoryUserSource } from '@basaltkit/auth'
    import { teamsPlugin${extra ? ', ' + extra : ''} } from '@basaltkit/teams'
    export const app = createApp({ plugins: [
      securityPlugin(),
      tenancyPlugin({ source: new MemoryTenantSource(), resolvers: [headerResolver()] }),
      authPlugin({ users: new MemoryUserSource(), secret: env.APP_SECRET }),
      teamsPlugin(),
      ${extra ? extra + '(),' : ''}
      fastifyPlugin({ routes: [] }),
    ] })
  `

  it('fires as an ERROR when tenancy + auth + teams are wired but the membership guard is not', () => {
    const ctx = detectProject('/vuln', memoryReader({ ...base, 'src/app.ts': appWith('') }))
    const d = runDoctor(ctx).find((x) => x.id === 'missing-tenant-membership')
    expect(d?.severity).toBe('error')
  })

  it('clears once tenantMembershipPlugin is registered', () => {
    const ctx = detectProject('/safe', memoryReader({ ...base, 'src/app.ts': appWith('tenantMembershipPlugin') }))
    const ids = runDoctor(ctx).map((x) => x.id)
    expect(ids).not.toContain('missing-tenant-membership')
  })
})

describe('runDoctor on a healthy project', () => {
  const healthy = {
    'package.json': JSON.stringify({ dependencies: { '@basaltkit/fastify': '^1.0.0', '@basaltkit/prisma': '^1.0.0' } }),
    'src/app.ts': "import { securityPlugin } from '@basaltkit/fastify'\nexport const app = createApp({ plugins: [ securityPlugin(), prismaPlugin({}), fastifyPlugin({ fastify: { logger: true }, routes: [] }) ] })",
    'src/server.ts': "const app = await buildApp().boot()\nawait app.container.get(PRISMA).$connect()\nawait server.listen({ port: 3000 })",
    'src/env.ts': "APP_SECRET: z.string().min(32),",
    'prisma/schema.prisma': 'datasource db { provider = "postgresql" url = env("DATABASE_URL") }\nmodel Tenant { id String @id }',
  }
  it('returns no diagnostics', () => {
    const ctx = detectProject('/ok', memoryReader(healthy))
    expect(runDoctor(ctx)).toEqual([])
  })
})

describe('in-memory-security-store rule', () => {
  const files = {
    'package.json': JSON.stringify({ dependencies: { '@basaltkit/auth': '^1.0.0' } }),
    'src/app.ts': `
      import { webauthnPlugin, MemoryPasskeyStore } from '@basaltkit/auth'
      export const app = createApp({ plugins: [
        webauthnPlugin({ config, verifier, credentials: new MemoryPasskeyStore() }),
      ] })
    `,
  }
  const found = runDoctor(detectProject('/proj', memoryReader(files)))

  it('flags a security store kept in memory as a warning', () => {
    const d = found.find((x) => x.id === 'in-memory-security-store')
    expect(d?.severity).toBe('warning')
    expect(d?.category).toBe('security')
    expect(d?.detected).toContain('WebAuthn passkeys')
  })

  it('does not fire when no in-memory security store is used', () => {
    const clean = runDoctor(detectProject('/p', memoryReader({
      'package.json': '{}',
      'src/app.ts': 'export const app = createApp({ plugins: [] })',
    })))
    expect(clean.find((x) => x.id === 'in-memory-security-store')).toBeUndefined()
  })
})
