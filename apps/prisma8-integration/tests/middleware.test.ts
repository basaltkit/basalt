import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import postgres from '@prisma/orm-postgres/runtime'
import { contractFromJson } from '@prisma/orm-postgres/static'
import { AndExpr, BinaryExpr, ColumnRef, ParamRef } from '@prisma/orm-postgres/relational-core/ast'
import type { Contract } from '../prisma/contract.js'
import contractJson from '../prisma/contract.json' with { type: 'json' }
import { databaseUrl, serverUrl } from './support/db.js'

// Middleware on Prisma 8 RC: what the official `beforeCompile` hook can and cannot do
// for tenancy. Prisma documents it for "tenant isolation" filters and warns not to rely
// on it alone (includes and joins are not filtered). Gated on TEST_DATABASE_URL.

const tenantFilter = (tenant: string) => ({
  familyId: 'sql' as const,
  async beforeCompile(draft: any) {
    const ast = draft.ast
    if (ast.kind !== 'select' && ast.kind !== 'update' && ast.kind !== 'delete') return undefined
    const source = ast.kind === 'select' ? ast.from : ast.table
    if (source?.kind !== 'table-source' || source.name !== 'Note') return undefined
    const own = BinaryExpr.eq(ColumnRef.of(source.alias ?? source.name, 'tenantId'), ParamRef.of(tenant, { codec: { codecId: 'pg/text@1' } }))
    return { ...draft, ast: ast.withWhere(ast.where ? AndExpr.of([ast.where, own]) : own) }
  },
})

describe.skipIf(!serverUrl)('Prisma 8 RC: middleware and tenancy', () => {
  let admin: pg.Client
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl() })
    await admin.connect()
    await admin.query(`DELETE FROM public."NoteTag"`) // its foreign key to Note
    await admin.query(`DELETE FROM public."Note"`)
    await admin.query(`INSERT INTO public."Note" (id, "tenantId", body) VALUES ('m-acme', 'acme', 'a'), ('m-globex', 'globex', 'g')`)
  })
  afterAll(async () => {
    await admin?.end()
  })

  it('cannot point a query at a schema the contract does not declare (RUNTIME.NAMESPACE_UNKNOWN)', async () => {
    const toTenantSchema = {
      familyId: 'sql' as const,
      async beforeCompile(draft: any) {
        return { ...draft, ast: draft.ast.rewrite({ tableSource: (s: any) => s.constructor.named(s.name, s.alias, 'tenant_acme') }) }
      },
    }
    const db = postgres({ contract: contractFromJson<Contract>(contractJson as never), url: databaseUrl(), verifyMarker: false, middleware: [toTenantSchema as never] })
    try {
      await expect(db.orm.public.Project.all()).rejects.toMatchObject({ code: 'RUNTIME.NAMESPACE_UNKNOWN' })
    } finally {
      await db.close()
    }
  })

  it('adds a tenant predicate to reads, updates and deletes (the documented use)', async () => {
    // Connected as the owner (RLS bypassed), so only the middleware filters.
    const db = postgres({ contract: contractFromJson<Contract>(contractJson as never), url: databaseUrl(), verifyMarker: false, middleware: [tenantFilter('acme') as never] })
    try {
      expect((await db.orm.public.Note.all()).map((n) => n.id)).toEqual(['m-acme'])
      expect(await db.orm.public.Note.where({ id: 'm-globex' }).first()).toBeNull()
      await db.orm.public.Note.where({ id: 'm-globex' }).updateAll({ body: 'tampered' })
      await db.orm.public.Note.where({ id: 'm-globex' }).deleteAll()
      expect((await admin.query(`SELECT body FROM public."Note" WHERE id = 'm-globex'`)).rows).toEqual([{ body: 'g' }])
    } finally {
      await db.close()
    }
  })

  it('does not stamp writes: an insert for another tenant goes through (why RLS stays the guarantee)', async () => {
    const db = postgres({ contract: contractFromJson<Contract>(contractJson as never), url: databaseUrl(), verifyMarker: false, middleware: [tenantFilter('acme') as never] })
    try {
      await db.orm.public.Note.create({ id: 'm-smuggled', tenantId: 'globex', body: 'written by acme' })
      expect((await admin.query(`SELECT "tenantId" FROM public."Note" WHERE id = 'm-smuggled'`)).rows).toEqual([{ tenantId: 'globex' }])
    } finally {
      await db.close()
      await admin.query(`DELETE FROM public."Note" WHERE id = 'm-smuggled'`)
    }
  })
})
