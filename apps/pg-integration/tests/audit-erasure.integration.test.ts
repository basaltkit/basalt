import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PrismaPg } from '@prisma/adapter-pg'
import { Audit, AUDIT_ERASED, type AuditOptions } from '@basaltkit/audit'
import { prismaAuditStore } from '@basaltkit/audit-prisma'

// The hardening the @basaltkit/audit-prisma README prescribes, against real
// PostgreSQL privileges: the application role may only SELECT/INSERT the
// trail, and erasure (Audit.redact) runs through a dedicated eraser role that
// may update only the erasable columns. Gated on TEST_DATABASE_URL.
const url = process.env['TEST_DATABASE_URL']

const APP_ROLE = 'basalt_audit_app'
const ERASER_ROLE = 'basalt_audit_eraser'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = any

const options: AuditOptions = { integrity: { mode: 'hash-chain', key: 'k'.repeat(32), keyId: 'k1' } }

/** The guard-trigger SQL exactly as the audit-prisma README documents it, one statement per element. */
const guardStatements = (): string[] => {
  const readme = readFileSync(new URL('../../../packages/audit-prisma/README.md', import.meta.url), 'utf8')
  const block = /<!-- audit-prisma:postgres-guard -->\s*```sql\n([\s\S]*?)```/.exec(readme)
  if (!block) throw new Error('postgres guard snippet not found in the audit-prisma README')
  return block[1]!.split(/;\n\n/).map((s) => s.trim().replace(/;$/, '')).filter(Boolean)
}

describe.skipIf(!url)('@basaltkit/audit-prisma erasure against real PostgreSQL privileges', () => {
  let admin: Client
  let app: Client
  let eraser: Client

  const connectAs = (PrismaClient: new (opts?: unknown) => Client, role: string): Client => {
    const roleUrl = new URL(url!)
    roleUrl.username = role
    roleUrl.password = role
    return new PrismaClient({ adapter: new PrismaPg({ connectionString: roleUrl.toString() }) })
  }

  beforeAll(async () => {
    const clientModule: string = '../generated/client/index.js'
    const { PrismaClient } = (await import(clientModule)) as { PrismaClient: new (opts?: unknown) => Client }
    admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
    for (const role of [APP_ROLE, ERASER_ROLE]) {
      await admin.$executeRawUnsafe(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
            CREATE ROLE ${role} LOGIN PASSWORD '${role}' NOSUPERUSER;
          END IF;
        END $$`)
      await admin.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${role}`)
      await admin.$executeRawUnsafe(`REVOKE ALL ON "audit_entries" FROM ${role}`)
      await admin.$executeRawUnsafe(`GRANT SELECT, INSERT ON "audit_entries" TO ${role}`)
    }
    await admin.$executeRawUnsafe(
      `GRANT UPDATE ("payload", "ip", "userAgent", "redaction", "redactedBy") ON "audit_entries" TO ${ERASER_ROLE}`,
    )
    for (const statement of guardStatements()) await admin.$executeRawUnsafe(statement)
    await admin.auditEntry.deleteMany()
    app = connectAs(PrismaClient, APP_ROLE)
    eraser = connectAs(PrismaClient, ERASER_ROLE)
  })

  afterAll(async () => {
    await admin?.$executeRawUnsafe('DROP TRIGGER IF EXISTS audit_entries_redaction_only ON "audit_entries"')
    await admin?.auditEntry.deleteMany()
    await app?.$disconnect()
    await eraser?.$disconnect()
    await admin?.$disconnect()
  })

  it('the app role appends but cannot UPDATE or DELETE; the eraser role redacts and cannot rewrite a hash', async () => {
    const appAudit = new Audit(prismaAuditStore(app).store, undefined, undefined, options)
    const entry = await appAudit.record('order.placed', { orderId: 'o-1', customer: { email: 'ana@example.com' } })
    await appAudit.record('next', { n: 1 })

    await expect(app.$executeRawUnsafe(`UPDATE "audit_entries" SET "payload" = '{}' WHERE "id" = $1`, entry.id)).rejects.toThrow(/permission denied/)
    await expect(app.$executeRawUnsafe(`DELETE FROM "audit_entries" WHERE "id" = $1`, entry.id)).rejects.toThrow(/permission denied/)
    // The app role cannot redact either: erasure is the eraser's alone.
    await expect(appAudit.redact(entry.id, { payload: ['customer.email'] })).rejects.toThrow(/permission denied/)

    const eraserAudit = new Audit(prismaAuditStore(eraser).store, undefined, undefined, options)
    const { attestation } = await eraserAudit.systemRedact(entry.id, { payload: ['customer.email'], reasonRef: 'DSR-1' })
    const stored = await prismaAuditStore(app).store.get(entry.id)
    expect(stored!.payload).toEqual({ orderId: 'o-1', customer: { email: AUDIT_ERASED } })
    expect(stored!.redaction).toMatchObject({ attestationId: attestation!.id, payload: ['customer.email'] })
    expect(await appAudit.verify()).toMatchObject({ ok: true, checked: 3, redacted: 1 })

    await expect(eraser.$executeRawUnsafe(`UPDATE "audit_entries" SET "hash" = 'x' WHERE "id" = $1`, entry.id)).rejects.toThrow(/permission denied/)
    await expect(eraser.$executeRawUnsafe(`DELETE FROM "audit_entries" WHERE "id" = $1`, entry.id)).rejects.toThrow(/permission denied/)
    // The guard trigger: even an allowed column may not clear the marker.
    await expect(eraser.$executeRawUnsafe(`UPDATE "audit_entries" SET "redactedBy" = NULL WHERE "id" = $1`, entry.id)).rejects.toThrow(/attested redaction/)
  })

  it('a stale optimistic token is a conflict on a real database', async () => {
    const appAudit = new Audit(prismaAuditStore(app).store, undefined, undefined, options)
    const entry = await appAudit.record('x', { email: 'a@b.co', name: 'Ana' })
    const a = new Audit(prismaAuditStore(eraser).store, undefined, undefined, options)
    const b = new Audit(prismaAuditStore(eraser).store, undefined, undefined, options)
    await Promise.all([a.systemRedact(entry.id, { payload: ['email'] }), b.systemRedact(entry.id, { payload: ['name'] })])
    const stored = await prismaAuditStore(app).store.get(entry.id)
    expect(stored!.redaction!.payload).toEqual(['email', 'name'])
    expect(await appAudit.verify()).toMatchObject({ ok: true })
  })
})
