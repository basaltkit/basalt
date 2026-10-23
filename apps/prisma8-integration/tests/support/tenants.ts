import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { appDir } from './db.js'

/**
 * The two pieces a Prisma 8 schema-per-tenant needs, as this harness found them
 * on the release candidate. Both lean on details Prisma does not document; that
 * is exactly what this harness exists to watch from one RC to the next.
 *
 * - Queries: the ORM qualifies every statement with the contract's namespace
 *   (`"public"."Project"`), so a connection's search_path does not move it. A
 *   copy of the contract whose storage namespace id is the tenant's schema does:
 *   the app keeps `db.orm.public.Project` and its generated types.
 * - Migrations: `prisma db update` diffs the live database against a contract.
 *   A contract wrapped in `namespace tenant_<id> { … }` plans exactly that
 *   schema's DDL. The marker (`prisma_contract.marker`) is one per database, so
 *   each tenant update overwrites it; updating the central plane last restores it.
 */

/** A contract whose storage namespace `public` points at `schema`. */
export function contractForSchema<T>(contractJson: T, schema: string): T {
  const copy = structuredClone(contractJson) as { storage?: { namespaces?: Record<string, { id?: string }> } }
  const namespace = copy.storage?.namespaces?.['public']
  if (!namespace || namespace.id !== 'public') {
    throw new Error('contract.json no longer has storage.namespaces.public.id — the Prisma 8 contract format changed')
  }
  namespace.id = schema
  return copy as T
}

/**
 * Writes `.tenants/<schema>/` with the central PSL wrapped in `namespace <schema> { … }`
 * (plus `extra` lines inside the last model, to simulate an evolution) and a config
 * pointing at it. Returns the config path.
 */
export async function writeTenantContract(schema: string, extra: string[] = []): Promise<string> {
  const central = await readFile(join(appDir, 'prisma', 'contract.prisma'), 'utf8')
  const body = central
    .split('\n')
    .filter((line) => !line.startsWith('// use prisma-8') && !line.startsWith('//'))
    .join('\n')
    .trim()
  const withExtra = extra.length === 0 ? body : body.replace(/\n}\s*$/, `\n${extra.map((l) => `  ${l}`).join('\n')}\n}`)
  const psl = `// use prisma-8\n\nnamespace ${schema} {\n${withExtra.split('\n').map((l) => (l ? `  ${l}` : l)).join('\n')}\n}\n`
  const dir = join(appDir, '.tenants', schema)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'contract.prisma'), psl)
  const config = join(dir, 'prisma.config.ts')
  await writeFile(
    config,
    `import { definePrismaConfig } from '@prisma/cli-engine'\n` +
      `import { defineConfig as ormConfig } from '@prisma/orm-postgres/config'\n` +
      `export default definePrismaConfig({ orm: ormConfig({ contract: './contract.prisma', db: { connection: process.env['PRISMA8_DATABASE_URL']! } }) })\n`,
  )
  return config
}
