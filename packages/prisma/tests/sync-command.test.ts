import { describe, expect, it } from 'vitest'
import { extractSchemaBlocks, prismaSyncCommand } from '../src/sync-command.js'
import { memoryIo } from '@machize/cli'

describe('extractSchemaBlocks', () => {
  it('extracts model and enum blocks with their full text', () => {
    const schema = `datasource db { provider = "postgresql" }
generator client { provider = "prisma-client-js" }

model AuthUser {
  id    String @id
  email String @unique
}

enum Role {
  admin
  member
}

model AuthSession {
  id     String @id
  userId String
  @@index([userId])
}`
    const blocks = extractSchemaBlocks(schema)
    expect(blocks.map((b) => b.name)).toEqual(['AuthUser', 'Role', 'AuthSession'])
    expect(blocks.map((b) => b.kind)).toEqual(['model', 'enum', 'model'])
    expect(blocks[0]?.text).toContain('email String @unique')
    expect(blocks[2]?.text).toContain('@@index([userId])')
    // datasource/generator are not blocks we manage
    expect(blocks.some((b) => b.name === 'db' || b.name === 'client')).toBe(false)
  })

  it('returns nothing for a schema with no models', () => {
    expect(extractSchemaBlocks('datasource db { provider = "sqlite" }')).toEqual([])
  })
})

describe('prismaSyncCommand', () => {
  const ctx = (flags: Record<string, string | boolean> = {}) => ({
    io: memoryIo(),
    flags,
    args: [] as string[],
    // app/container are unused by this command
    app: {} as never,
    container: {} as never,
  })

  it('errors when the schema file does not exist', async () => {
    const c = prismaSyncCommand({ schemaPath: '/tmp/machize-does-not-exist-xyz.prisma' })
    const context = ctx()
    const code = await c.handle(context)
    expect(code).toBe(1)
    expect(context.io.errors.join(' ')).toMatch(/No schema found/)
  })
})
