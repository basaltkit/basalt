import { describe, expect, it } from 'vitest'
import { detectProject, memoryReader } from '../src/index.js'

const APP = `
import { fastifyPlugin } from '@basaltkit/fastify'
import { tenancyPlugin, MemoryTenantSource } from '@basaltkit/tenancy'
import { authPlugin } from '@basaltkit/auth'
import { prismaPlugin } from '@basaltkit/prisma'

export function buildApp() {
  return createApp({
    plugins: [
      loggerPlugin({ level: 'info' }),
      tenancyPlugin({ source: new MemoryTenantSource() }),
      authPlugin({ secret: env.APP_SECRET }),
      prismaPlugin({ client: prisma }),
      fastifyPlugin({ routes: [] }),
    ],
  })
}
`

const SCHEMA = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
model Tenant {
  id   String @id
  name String
}
model Post {
  id       String @id
  tenantId String
  name     String
}
model LooseThing {
  id   String @id
  name String
}
`

const files = {
  'package.json': JSON.stringify({
    dependencies: { '@basaltkit/fastify': '^1.0.0', '@basaltkit/prisma': '^1.0.0', '@basaltkit/permissions': '^1.0.0' },
  }),
  'src/app.ts': APP,
  'src/server.ts': "const app = await buildApp().boot()\nawait server.listen({ port: 3000 })",
  'src/env.ts': "APP_SECRET: z.string().default('change-me-in-production--'),\nREDIS_URL: z.string().default('redis://localhost:6379'),",
  'prisma/schema.prisma': SCHEMA,
}

describe('detectProject', () => {
  const ctx = detectProject('/proj', memoryReader(files))

  it('detects the wired stack from app.ts plugins', () => {
    expect(ctx.stack.http).toBe('fastify')
    expect(ctx.stack.orm).toBe('prisma')
    expect(ctx.stack.tenancy).toBe(true)
    expect(ctx.stack.auth).toBe(true)
    expect(ctx.stack.logger).toBe(true)
  })

  it('falls back to installed packages for RBAC (permissions)', () => {
    expect(ctx.stack.rbac).toBe(true)
  })

  it('reads the database provider and models', () => {
    expect(ctx.stack.database).toBe('postgresql')
    expect(ctx.prisma?.models.map((m) => m.name)).toEqual(['Tenant', 'Post', 'LooseThing'])
    expect(ctx.prisma?.models.find((m) => m.name === 'Post')?.tenantScoped).toBe(true)
    expect(ctx.prisma?.models.find((m) => m.name === 'LooseThing')?.tenantScoped).toBe(false)
  })

  it('captures env defaults and boot/logger signals', () => {
    expect(ctx.env?.appSecretDefault).toBe('change-me-in-production--')
    expect(ctx.env?.redisUrlDefault).toBe('redis://localhost:6379')
    expect(ctx.server?.connectsAtBoot).toBe(false)
    expect(ctx.app?.fastifyLoggerConfigured).toBe(false)
    expect(ctx.app?.memorySources).toContain('MemoryTenantSource')
  })

  it('lists installed basalt packages', () => {
    expect(ctx.installed).toContain('@basaltkit/fastify')
  })
})
