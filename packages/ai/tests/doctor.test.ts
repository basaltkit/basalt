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
})

describe('runDoctor on a healthy project', () => {
  const healthy = {
    'package.json': JSON.stringify({ dependencies: { '@basaltkit/fastify': '^1.0.0', '@basaltkit/prisma': '^1.0.0' } }),
    'src/app.ts': "export const app = createApp({ plugins: [ prismaPlugin({}), fastifyPlugin({ fastify: { logger: true }, routes: [] }) ] })",
    'src/server.ts': "const app = await buildApp().boot()\nawait app.container.get(PRISMA).$connect()\nawait server.listen({ port: 3000 })",
    'src/env.ts': "APP_SECRET: z.string().min(32),",
    'prisma/schema.prisma': 'datasource db { provider = "postgresql" url = env("DATABASE_URL") }\nmodel Tenant { id String @id }',
  }
  it('returns no diagnostics', () => {
    const ctx = detectProject('/ok', memoryReader(healthy))
    expect(runDoctor(ctx)).toEqual([])
  })
})
