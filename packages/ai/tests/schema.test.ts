import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  detectProject,
  extractModelBlock,
  mergeModelsIntoSchema,
  runMake,
  type ArchitecturePlan,
} from '../src/index.js'

describe('extractModelBlock', () => {
  it('pulls the model block out of a generated snippet', () => {
    const snippet = `// Add this model…\nmodel Client {\n  id String @id\n  name String\n\n  @@index([tenantId])\n}\n`
    const block = extractModelBlock(snippet)
    expect(block?.name).toBe('Client')
    expect(block?.block).toMatch(/^model Client \{/)
    expect(block?.block).toContain('@@index([tenantId])')
  })
})

describe('mergeModelsIntoSchema', () => {
  const schema = 'datasource db {\n  provider = "postgresql"\n}\n\nmodel Tenant {\n  id String @id\n}\n'
  const client = { name: 'Client', block: 'model Client {\n  id String @id\n}' }

  it('appends a new model', () => {
    const out = mergeModelsIntoSchema(schema, [client])
    expect(out.merged).toEqual(['Client'])
    expect(out.skipped).toEqual([])
    expect(out.content).toContain('model Client {')
    expect(out.content).toContain('model Tenant {') // preserved
  })

  it('is idempotent — skips a model already present', () => {
    const once = mergeModelsIntoSchema(schema, [client]).content
    const twice = mergeModelsIntoSchema(once, [client])
    expect(twice.merged).toEqual([])
    expect(twice.skipped).toEqual(['Client'])
    expect(twice.content.match(/model Client \{/g)).toHaveLength(1)
  })
})

describe('runMake schema merge (real dir)', () => {
  let root: string
  const plan: ArchitecturePlan = {
    request: 'r',
    summary: 's',
    entities: [{ name: 'Client', tenantScoped: true, fields: [{ name: 'name', type: 'String' }] }],
    steps: [{ order: 1, title: 'x', kind: 'generator', detail: '', command: 'basalt make:resource Client --prisma' }],
    permissions: [],
    auditEvents: [],
    tenantScoped: true,
    warnings: [],
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'basalt-ai-schema-'))
    await mkdir(join(root, 'prisma'), { recursive: true })
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { '@basaltkit/prisma': '^1' } }))
    await writeFile(join(root, 'src/app.ts'), 'createApp({ plugins: [ tenancyPlugin({}), prismaPlugin({}), fastifyPlugin({}) ] })')
    await writeFile(
      join(root, 'prisma/schema.prisma'),
      'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n\nmodel Tenant {\n  id String @id\n}\n',
    )
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('merges the generated model into prisma/schema.prisma (no --migrate = no push)', async () => {
    const ctx = detectProject(root)
    const result = await runMake(ctx, plan, { baseDir: root }) // real write, migrate off
    expect(result.schema?.found).toBe(true)
    expect(result.schema?.merged).toEqual(['Client'])
    expect(result.schema?.written).toBe(true)
    expect(result.migration).toBeUndefined()

    const schema = await readFile(join(root, 'prisma/schema.prisma'), 'utf8')
    expect(schema).toContain('model Client {')
    expect(schema).toContain('model Tenant {') // preserved

    // review says the model is in the schema, follow-up says run db push
    expect(result.review.items.find((i) => i.label === 'Migration')?.detail).toMatch(/run npx prisma db push/)
    expect(result.followUps.join('\n')).toMatch(/prisma db push/)
  })

  it('dry-run reports the merge but writes nothing', async () => {
    const ctx = detectProject(root)
    const result = await runMake(ctx, plan, { baseDir: root, dryRun: true })
    expect(result.schema?.merged).toEqual(['Client'])
    expect(result.schema?.written).toBe(false)
    const schema = await readFile(join(root, 'prisma/schema.prisma'), 'utf8')
    expect(schema).not.toContain('model Client {')
  })
})
