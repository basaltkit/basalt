import { describe, expect, it } from 'vitest'
import { detectProject, fixableIds, memoryReader, planFix } from '../src/index.js'

const files = {
  'package.json': JSON.stringify({ dependencies: { '@basaltkit/fastify': '^1', '@basaltkit/prisma': '^1' } }),
  'src/app.ts':
    'createApp({ plugins: [ prismaPlugin({}), fastifyPlugin({ routes: [...appRoutes] }) ] })',
  'src/env.ts': "export const env = defineEnv({\n  APP_SECRET: z.string().default('change-me-in-production--'),\n})",
  'prisma/schema.prisma': 'datasource db { provider = "postgresql" url = env("X") }\nmodel Tenant { id String @id }',
}
const reader = memoryReader(files)
const ctx = detectProject('/p', reader)
const read = (rel: string): string | null => reader.read(rel)

describe('planFix', () => {
  it('lists the auto-fixable rule ids', () => {
    expect(fixableIds()).toEqual(expect.arrayContaining(['fastify-logger-off', 'insecure-app-secret']))
  })

  it('adds the Fastify logger option to app.ts', () => {
    const outcome = planFix('fastify-logger-off', ctx, read)
    expect(outcome.status).toBe('ready')
    const after = outcome.edits[0]?.after ?? ''
    expect(after).toContain("fastify: { logger: process.env.NODE_ENV !== 'production' }")
    expect(after).toContain('routes: [...appRoutes]') // routes untouched
  })

  it('removes the insecure APP_SECRET default and sets min(32)', () => {
    const outcome = planFix('insecure-app-secret', ctx, read)
    expect(outcome.status).toBe('ready')
    const after = outcome.edits[0]?.after ?? ''
    expect(after).toContain('APP_SECRET: z.string().min(32),')
    expect(after).not.toContain('change-me-in-production')
  })

  it('is a no-op when the issue is already fixed', () => {
    const fixed = memoryReader({
      ...files,
      'src/app.ts': 'createApp({ plugins: [ fastifyPlugin({ fastify: { logger: true }, routes: [] }) ] })',
    })
    const outcome = planFix('fastify-logger-off', detectProject('/p', fixed), (r) => fixed.read(r))
    expect(outcome.status).toBe('noop')
    expect(outcome.edits).toEqual([])
  })

  it('reports unfixable for a rule without an auto-fix', () => {
    const outcome = planFix('tenant-scoping-missing', ctx, read)
    expect(outcome.status).toBe('unfixable')
    expect(outcome.message).toMatch(/no auto-fix/)
  })
})
