import { join } from 'node:path'
import { DeployError, type DeployContext } from './context.js'
import type { InfraPlan } from './infra.js'

/**
 * `pg_dump -Fc` of the central database before migrating — migrations do not
 * undo themselves, and rollback restores code only (RFC 0006 §8). With
 * schema-per-tenant every company's schema is in the same database, so one
 * dump covers them all.
 *
 * With dedicated infra the dump runs INSIDE the container: same pg_dump major
 * as the server, by construction, and no password needed on the local socket.
 */
export async function backupDatabase(ctx: DeployContext, values: Map<string, string>, infra: InfraPlan, sha: string): Promise<string> {
  const { host, config } = ctx
  const dir = join(ctx.dir, config.backup?.dir ?? 'backups/predeploy')
  await host.mkdir(dir, 0o700)
  const stamp = host.now().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  const file = join(dir, `${stamp}-${sha.slice(0, 7)}.dump`)

  const pg = infra.services.find((s) => s.service === 'postgres')
  let result
  if (pg) {
    result = await host.exec('docker', ['exec', pg.container, 'pg_dump', '-U', pg.user ?? config.app, '-d', pg.database ?? config.app, '--format=custom', '--no-owner', '--no-acl'], { stdoutFile: file })
  } else {
    const key = config.backup?.urlKey ?? 'DATABASE_URL'
    const raw = values.get(key)
    if (!raw) throw new DeployError(`backup: ${key} is not set in the .env`)
    const url = new URL(raw)
    const password = decodeURIComponent(url.password)
    url.password = ''
    // Prisma's `?schema=` is not a libpq parameter; pg_dump refuses it.
    url.search = ''
    result = await host.exec('pg_dump', ['--dbname', url.toString(), '--format=custom', '--no-owner', '--no-acl'], { stdoutFile: file, env: { PGPASSWORD: password } })
  }
  const size = (await host.stat(file))?.size ?? 0
  if (result.code !== 0 || size === 0) {
    await host.remove(file)
    throw new DeployError(`pg_dump failed — nothing was changed: ${result.stderr.trim().split('\n')[0] ?? ''}`)
  }

  const keep = config.backup?.keep ?? 10
  const dumps = (await host.list(dir)).filter((name) => name.endsWith('.dump')).sort()
  for (const old of dumps.slice(0, -keep)) await host.remove(join(dir, old))
  return file
}

export function restoreCommand(ctx: DeployContext, infra: InfraPlan, file: string): string {
  const pg = infra.services.find((s) => s.service === 'postgres')
  if (pg) return `docker exec -i ${pg.container} pg_restore --clean --if-exists --no-owner -U ${pg.user ?? ctx.config.app} -d ${pg.database ?? ctx.config.app} < ${file}`
  return `pg_restore --clean --if-exists --no-owner --dbname "<the database URL, without ?schema=>" ${file}`
}
