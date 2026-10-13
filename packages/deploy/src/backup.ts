import { join } from 'node:path'
import { DeployError, type DeployContext } from './context.js'
import type { InfraPlan } from './infra.js'
import { dumpContainer, dumpUrlKey } from './services.js'

/**
 * `pg_dump -Fc` of the central database before migrating — migrations do not
 * undo themselves, and rollback restores code only (RFC 0006 §8). With
 * schema-per-tenant every company's schema is in the same database, so one
 * dump covers them all.
 *
 * With dedicated infra, or `backup.container`, the dump runs INSIDE the
 * container: same pg_dump major as the server, by construction. The password,
 * when there is one, travels in the environment (`docker exec -e PGPASSWORD`,
 * no value), never on a command line.
 */
/**
 * Where the dumps go: `<stateDir>/backups` (0700) — outside the checkout, so
 * never in a `COPY . .` image, a commit or a served directory. `backup.dir`
 * (relative to the checkout) keeps the old place for those who chose it.
 */
export const backupDir = (ctx: DeployContext) => (ctx.config.backup?.dir ? join(ctx.dir, ctx.config.backup.dir) : join(ctx.stateDir, 'backups'))

export async function backupDatabase(ctx: DeployContext, values: Map<string, string>, infra: InfraPlan, sha: string): Promise<string> {
  const { host, config } = ctx
  const dir = backupDir(ctx)
  await host.mkdir(dir, 0o700)
  // A directory made earlier with a looser mode: every dump is the whole database.
  const made = await host.stat(dir)
  if (made?.kind === 'dir' && made.uid === host.uid() && made.mode !== undefined && (made.mode & 0o077) !== 0) await host.chmod(dir, 0o700)
  const stamp = host.now().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  const file = join(dir, `${stamp}-${sha.slice(0, 7)}.dump`)

  const pg = infra.services.find((s) => s.service === 'postgres')
  let result
  if (pg) {
    result = await host.exec('docker', ['exec', pg.container, 'pg_dump', '-U', pg.user ?? config.app, '-d', pg.database ?? config.app, '--format=custom', '--no-owner', '--no-acl'], { stdoutFile: file })
  } else {
    const url = databaseUrl(ctx, values)
    const password = decodeURIComponent(url.password)
    const container = dumpContainer(config)
    if (container) {
      const args = ['exec', '-e', 'PGPASSWORD', container, 'pg_dump', '-U', decodeURIComponent(url.username), '-d', databaseName(url), '--format=custom', '--no-owner', '--no-acl']
      result = await host.exec('docker', args, { stdoutFile: file, env: { PGPASSWORD: password } })
    } else {
      url.password = ''
      // Prisma's `?schema=` is not a libpq parameter; pg_dump refuses it.
      url.search = ''
      result = await host.exec('pg_dump', ['--dbname', url.toString(), '--format=custom', '--no-owner', '--no-acl'], { stdoutFile: file, env: { PGPASSWORD: password } })
    }
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

export function restoreCommand(ctx: DeployContext, infra: InfraPlan, file: string, values: Map<string, string> = new Map()): string {
  const pg = infra.services.find((s) => s.service === 'postgres')
  if (pg) return `docker exec -i ${pg.container} pg_restore --clean --if-exists --no-owner -U ${pg.user ?? ctx.config.app} -d ${pg.database ?? ctx.config.app} < ${file}`
  const container = dumpContainer(ctx.config)
  if (container) {
    const url = databaseUrl(ctx, values)
    return `docker exec -i ${container} pg_restore --clean --if-exists --no-owner -U ${decodeURIComponent(url.username)} -d ${databaseName(url)} < ${file}`
  }
  return `pg_restore --clean --if-exists --no-owner --dbname "<the database URL, without ?schema=>" ${file}`
}

function databaseUrl(ctx: DeployContext, values: Map<string, string>): URL {
  const key = dumpUrlKey(ctx.config)
  const raw = values.get(key)
  if (!raw) throw new DeployError(`backup: ${key} is not set in the .env`)
  return new URL(raw)
}

function databaseName(url: URL): string {
  return decodeURIComponent(url.pathname.replace(/^\//, ''))
}
