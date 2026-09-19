import { describe, expect, it } from 'vitest'
import {
  detectProject,
  memoryReader,
  renderPrismaRepository,
  runMake,
  zodForField,
  type ArchitecturePlan,
} from '../src/index.js'
import { ArchitecturePlanSchema } from '../src/schema/index.js'

/**
 * Security invariant (deep audit 2026-09, F72): a plan is untrusted input (an
 * LLM output, or a plan object an MCP client sends to basalt_make). Nothing in
 * it may become live code in the developer's generated sources — enum values
 * are emitted as escaped string literals, and names must be plain identifiers.
 */

const PAYLOAD = "x'); require('child_process').execSync('touch /tmp/pwned'); ('"

const project = () =>
  detectProject(
    '/p',
    memoryReader({
      'package.json': JSON.stringify({ dependencies: { '@basaltkit/prisma': '^1', '@basaltkit/audit': '^1' } }),
      'src/app.ts': 'createApp({ plugins: [ tenancyPlugin({}), prismaPlugin({}), auditPlugin({}), fastifyPlugin({}) ] })',
      'prisma/schema.prisma': 'datasource db { provider = "postgresql" url = env("X") }\nmodel Tenant { id String @id }',
    }),
  )

const planWith = (patch: Partial<ArchitecturePlan> & { fields?: ArchitecturePlan['entities'][number]['fields'] }): ArchitecturePlan => ({
  request: 'faturas',
  summary: 's',
  entities: [{ name: 'Fatura', tenantScoped: true, fields: patch.fields ?? [{ name: 'numero', type: 'String' }] }],
  steps: [{ order: 1, title: 'x', kind: 'generator', detail: '', command: 'basalt make:resource Fatura --prisma' }],
  permissions: [],
  auditEvents: [],
  tenantScoped: true,
  warnings: [],
  ...patch,
})

/** Evaluates a TS string-literal union / z.enum argument list back to its values. */
const literalValues = (source: string): string[] =>
  // eslint-disable-next-line no-new-func
  new Function(`return [${source}]`)() as string[]

describe('plan → generated code: enum values never escape their string literal (security)', () => {
  it('zodForField escapes quotes, backslashes and newlines in enum values', () => {
    const values = [PAYLOAD, 'a\\', 'line\nbreak', "l'état", '"dq"', ' ']
    const out = zodForField({ name: 'estado', type: 'String', enum: values }, true)
    expect(out).not.toContain("require('child_process')")
    const inner = /^z\.enum\(\[(.*)\]\)$/s.exec(out)?.[1] ?? ''
    expect(literalValues(inner)).toEqual(values)
  })

  it('renderPrismaRepository escapes enum values in the mapper cast', () => {
    const src = renderPrismaRepository('Fatura', [{ name: 'estado', type: 'String', enum: [PAYLOAD, 'pago'] }], {
      softDelete: false,
      tenantScoped: true,
      keepName: false,
    })
    expect(src).not.toContain("require('child_process')")
    const cast = /estado: r\.estado as (.*),\n/.exec(src)?.[1] ?? ''
    expect(literalValues(cast.split(' | ').join(', '))).toEqual([PAYLOAD, 'pago'])
  })

  it('runMake end to end: a malicious enum value lands only as data', async () => {
    const r = await runMake(project(), planWith({ fields: [{ name: 'estado', type: 'String', enum: [PAYLOAD] }] }), {
      dryRun: true,
      baseDir: '/p',
    })
    for (const file of r.resources[0]?.files ?? []) expect(file.content).not.toContain("require('child_process')")
  })
})

describe('plan → generated code: names must be plain identifiers (security)', () => {
  const bad = [
    'x: z.string() }); process.exit(1); ({ y',
    'a b',
    '1abc',
    'x\nconst evil = 1',
    "x'",
  ]

  it.each(bad)('runMake refuses a field name that is not an identifier: %j', async (name) => {
    await expect(runMake(project(), planWith({ fields: [{ name, type: 'String' }] }), { dryRun: true, baseDir: '/p' })).rejects.toThrow(
      /not a valid identifier|unsafe/i,
    )
  })

  it('runMake refuses a relation name that is not an identifier', async () => {
    const plan = planWith({})
    plan.entities[0]!.relations = [{ name: 'x @relation(fields: [a]) } model Evil { id String @id', model: 'Cliente' }]
    await expect(runMake(project(), plan, { dryRun: true, baseDir: '/p' })).rejects.toThrow(/not a valid identifier|unsafe/i)
  })

  it('runMake refuses an audit event that could break out of its string literal', async () => {
    const plan = planWith({ auditEvents: ["fatura.created'); process.exit(1); ('"] })
    await expect(runMake(project(), plan, { dryRun: true, baseDir: '/p' })).rejects.toThrow(/audit event|unsafe/i)
  })

  it('ArchitecturePlanSchema rejects non-identifier field and relation names (MCP input validation)', () => {
    const base = planWith({})
    expect(ArchitecturePlanSchema.safeParse(base).success).toBe(true)
    const badField = planWith({ fields: [{ name: 'a b', type: 'String' }] })
    expect(ArchitecturePlanSchema.safeParse(badField).success).toBe(false)
    const badRelation = planWith({})
    badRelation.entities[0]!.relations = [{ name: "x'", model: 'Cliente' }]
    expect(ArchitecturePlanSchema.safeParse(badRelation).success).toBe(false)
  })

  it('still accepts ordinary plans (identifiers, multi-word entity names, dotted audit events)', async () => {
    const plan = planWith({
      entities: [{ name: 'Blog Post', tenantScoped: true, fields: [{ name: 'publishedAt', type: 'DateTime' }, { name: 'view_count', type: 'Int' }] }],
      steps: [],
      auditEvents: ['blog-post.created', 'blog_post:updated'],
    })
    await expect(runMake(project(), plan, { dryRun: true, baseDir: '/p' })).resolves.toBeDefined()
  })
})
