import { bucketName, type AppRole, type Bucket, type DeployConfig } from './config.js'
import { DeployError, type DeployContext, type Finding } from './context.js'
import type { EnvChange } from './dotenv.js'

/**
 * What every deploy keeps true of the app's services, dedicated or not
 * (RFC 0007 §4): the external containers are running, the app's database role
 * exists with the `.env`'s password and its grants, the buckets exist with
 * their policies. Each is idempotent and says what it did.
 *
 * Credentials never reach a command line: `docker exec -e NAME` (no value)
 * copies them from this process's environment, SQL with a password goes on
 * stdin.
 */

/** Where to reach Postgres as its owner, inside the container. */
export interface PostgresHandle {
  container: string
  user: string
  database: string
  password: string
  /** Over TCP (proves the password) or the local socket (as the image allows). */
  tcp: boolean
  /** The owner's URL, from which the app role's URL is derived. */
  url: string | undefined
}

export interface MinioHandle {
  container: string
  user: string
  password: string
}

export const externalOf = (config: DeployConfig) => (config.infra?.kind === 'external' ? config.infra : undefined)

/** The container the pre-migration dump runs in, with external infra: `backup.container`, else `infra.postgres.container`. */
export const dumpContainer = (config: DeployConfig): string | undefined => config.backup?.container ?? externalOf(config)?.postgres?.container

/** The `.env` key of the URL the dump connects with: `backup.urlKey`, else the external Postgres's owner URL. */
export const dumpUrlKey = (config: DeployConfig): string => config.backup?.urlKey ?? externalOf(config)?.postgres?.urlKey ?? 'DATABASE_URL'

/** The app role, wherever it is declared. */
export function appRoleOf(config: DeployConfig): AppRole | undefined {
  if (config.infra?.kind === 'docker') return config.infra.postgres?.appRole
  return externalOf(config)?.postgres?.appRole
}

/** The external containers, each running — before anything is built. */
export async function externalFindings(ctx: DeployContext): Promise<Finding[]> {
  const services = externalOf(ctx.config)
  if (!services) return []
  const findings: Finding[] = []
  for (const [service, container] of [['postgres', services.postgres?.container], ['redis', services.redis?.container], ['minio', services.minio?.container]] as const) {
    if (!container) continue
    const state = await ctx.host.exec('docker', ['inspect', '--format', '{{.State.Running}}', container])
    if (state.stdout.trim() === 'true') continue
    findings.push({
      id: 'infra',
      level: 'error',
      message: state.code === 0 ? `${service}: ${container} is not running` : `${service}: ${container} does not exist (or docker is not available to this user)`,
      fix: state.code === 0 ? `docker start ${container}` : 'a new server is prepared with basalt-deploy bootstrap; adopt a container under another name with infra.<service>.container',
    })
  }
  return findings
}

export function externalPostgres(ctx: DeployContext, values: Map<string, string>): PostgresHandle | undefined {
  const pg = externalOf(ctx.config)?.postgres
  if (!pg) return undefined
  const key = pg.urlKey ?? 'DATABASE_URL'
  const raw = values.get(key)
  if (!raw) throw new DeployError(`infra.postgres: ${key} is not set in the .env — it holds the owner's URL`)
  const url = new URL(raw)
  return {
    container: pg.container,
    user: decodeURIComponent(url.username),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    password: decodeURIComponent(url.password),
    tcp: false,
    url: raw,
  }
}

/**
 * The app role's URL: the owner's, with the role's name and a new password,
 * when the `.env` has none yet; then kept — the role follows its password.
 * When the database moves (another host, port or name: a recreated
 * container), the URL follows it and keeps the password.
 */
export function appRoleEnv(ctx: DeployContext, values: Map<string, string>, ownerUrl: string | undefined): EnvChange[] {
  const role = appRoleOf(ctx.config)
  if (!role || !ownerUrl) return []
  const owner = new URL(ownerUrl)
  const current = values.get(role.urlKey)
  if (!current) {
    const url = new URL(ownerUrl)
    url.username = role.name
    url.password = ctx.host.randomHex(24)
    return [{ kind: 'set', key: role.urlKey, value: url.toString(), reason: `password of the ${role.name} role (new)` }]
  }
  const url = new URL(current)
  if (url.host === owner.host && url.pathname === owner.pathname && url.search === owner.search && url.username === role.name) return []
  url.host = owner.host
  url.pathname = owner.pathname
  url.search = owner.search
  url.username = role.name
  return [{ kind: 'set', key: role.urlKey, value: url.toString(), reason: `the ${role.name} role follows the database (${owner.host}${owner.pathname})` }]
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`

async function psql(ctx: DeployContext, pg: PostgresHandle, sql: string, as?: { user: string; password: string }): Promise<{ code: number; stdout: string; stderr: string }> {
  const user = as?.user ?? pg.user
  const password = as?.password ?? pg.password
  const args = ['exec', '-i', '-e', 'PGPASSWORD', pg.container, 'psql', '-v', 'ON_ERROR_STOP=1', '-qtA', ...(pg.tcp || as ? ['-h', '127.0.0.1'] : []), '-U', user, '-d', pg.database]
  return ctx.host.exec('docker', args, { env: { PGPASSWORD: password }, stdin: sql })
}

/**
 * The role exists, logs in with the `.env`'s password, and gets DML on what the
 * owner creates in `public` (default privileges — never on existing tables: an
 * app may keep some append-only, as Globex's audit log is).
 */
export async function ensureAppRole(ctx: DeployContext, pg: PostgresHandle, role: AppRole, values: Map<string, string>): Promise<string> {
  const raw = values.get(role.urlKey)
  if (!raw) throw new DeployError(`appRole ${role.name}: ${role.urlKey} is not set in the .env`)
  const password = decodeURIComponent(new URL(raw).password)
  const exists = (await psql(ctx, pg, `SELECT 1 FROM pg_roles WHERE rolname = ${literal(role.name)};\n`)).stdout.trim() === '1'
  // Proven over TCP before anything is changed: an ALTER ROLE … PASSWORD on
  // every deploy would write the password to any statement log.
  const works = exists && (await psql(ctx, pg, 'SELECT 1;\n', { user: role.name, password })).code === 0
  const sql = [
    ...(exists ? [] : [`CREATE ROLE ${ident(role.name)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`]),
    ...(works ? [] : [`ALTER ROLE ${ident(role.name)} WITH LOGIN PASSWORD ${literal(password)};`]),
    `GRANT CONNECT ON DATABASE ${ident(pg.database)} TO ${ident(role.name)};`,
    `GRANT USAGE ON SCHEMA public TO ${ident(role.name)};`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(pg.user)} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ident(role.name)};`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(pg.user)} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${ident(role.name)};`,
  ].join('\n')
  const result = await psql(ctx, pg, `${sql}\n`)
  if (result.code !== 0) throw new DeployError(`appRole ${role.name}: ${result.stderr.trim().split('\n')[0] ?? 'psql failed'}`)
  return `role ${role.name}: ${exists ? (works ? 'in place' : 'password set from the .env') : 'created'}; grants in place`
}

/**
 * After the companies' migrations (RFC 0007 §11.3): every `tenant_*` schema
 * gets the role's DML on what it has and what its owner creates later. A new
 * company without them is an outage the role only finds at runtime.
 */
export async function grantTenantSchemas(ctx: DeployContext, pg: PostgresHandle, role: AppRole): Promise<string> {
  const r = ident(role.name)
  const owner = ident(pg.user)
  const sql = `DO $basalt$
DECLARE s text; n int := 0;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname LIKE 'tenant\\_%' LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO ${r.replace(/%/g, '%%')}', s);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO ${r.replace(/%/g, '%%')}', s);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO ${r.replace(/%/g, '%%')}', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE ${owner.replace(/%/g, '%%')} IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${r.replace(/%/g, '%%')}', s);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'basalt: % schema(s)', n;
END
$basalt$;
SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'tenant\\_%';
`
  const result = await psql(ctx, pg, sql)
  if (result.code !== 0) throw new DeployError(`appRole ${role.name} on the company schemas: ${result.stderr.trim().split('\n').pop() ?? 'psql failed'}`)
  return `role ${role.name}: granted on ${result.stdout.trim().split('\n').pop() ?? '0'} company schema(s)`
}

/** Credentials of a running MinIO: its own, never the config's. */
export async function minioHandle(ctx: DeployContext, container: string): Promise<MinioHandle> {
  const result = await ctx.host.exec('docker', ['inspect', container, '--format', '{{json .Config.Env}}'])
  if (result.code !== 0) throw new DeployError(`minio: cannot inspect ${container}`)
  const env = new Map((JSON.parse(result.stdout.trim() || '[]') as string[]).map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)] as const))
  const user = env.get('MINIO_ROOT_USER')
  const password = env.get('MINIO_ROOT_PASSWORD')
  if (!user || !password) throw new DeployError(`minio: ${container} has no MINIO_ROOT_USER/MINIO_ROOT_PASSWORD`)
  return { container, user, password }
}

/** Each bucket exists; versioning on where asked; the expiry rule added once. */
export async function ensureBuckets(ctx: DeployContext, minio: MinioHandle, buckets: Bucket[]): Promise<string> {
  if (buckets.length === 0) return ''
  const alias = `http://${encodeURIComponent(minio.user)}:${encodeURIComponent(minio.password)}@127.0.0.1:9000`
  const mc = (args: string[]) => ctx.host.exec('docker', ['exec', '-e', 'MC_HOST_local', minio.container, 'mc', ...args], { env: { MC_HOST_local: alias } })
  const fail = (what: string, result: { stderr: string }) => new DeployError(`minio: ${what}: ${result.stderr.trim().split('\n')[0] ?? 'mc failed'}`)

  const made = await mc(['mb', '-p', ...buckets.map((b) => `local/${bucketName(b)}`)])
  if (made.code !== 0) throw fail('creating the buckets', made)
  const said: string[] = []
  for (const bucket of buckets) {
    if (typeof bucket === 'string') { said.push(bucket); continue }
    const notes: string[] = []
    if (bucket.versioned) {
      const versioned = await mc(['version', 'enable', `local/${bucket.name}`])
      if (versioned.code !== 0) throw fail(`versioning ${bucket.name}`, versioned)
      notes.push('versioned')
    }
    if (bucket.expireDays !== undefined) {
      // `mc ilm rule add` adds ANOTHER rule every time: read the rules first.
      const rules = await mc(['ilm', 'rule', 'ls', '--json', `local/${bucket.name}`])
      const present = new RegExp(`"Expiration":\\s*\\{[^}]*"Days":\\s*${bucket.expireDays}\\b`).test(rules.stdout)
      if (!present) {
        const added = await mc(['ilm', 'rule', 'add', '--expire-days', String(bucket.expireDays), `local/${bucket.name}`])
        if (added.code !== 0) throw fail(`expiry on ${bucket.name}`, added)
      }
      notes.push(`${bucket.expireDays}-day expiry${present ? '' : ' (added)'}`)
    }
    said.push(notes.length ? `${bucket.name} (${notes.join(', ')})` : bucket.name)
  }
  return `buckets: ${said.join(', ')}`
}

/** What `plan` says about the services: the external containers, the role, the buckets. */
export function describeServices(config: DeployConfig): string[] {
  const lines: string[] = []
  const external = externalOf(config)
  for (const [service, container] of [['postgres', external?.postgres?.container], ['redis', external?.redis?.container], ['minio', external?.minio?.container]] as const) {
    if (container) lines.push(`${service}: ${container} (external, kept running by its owner)`)
  }
  const role = appRoleOf(config)
  if (role) lines.push(`role ${role.name}: created if missing, password from ${role.urlKey}, DML grants${config.migrate?.tenants ? ' (company schemas too, after the migration)' : ''}`)
  const buckets = [...(external?.minio?.buckets ?? []), ...(config.infra?.kind === 'docker' ? config.infra.minio?.buckets ?? [] : [])]
  const policies = buckets.filter((b) => typeof b === 'object' && (b.versioned || b.expireDays))
  if (policies.length) lines.push(`buckets: ${policies.map((b) => typeof b === 'object' ? `${b.name} (${[b.versioned ? 'versioned' : '', b.expireDays ? `${b.expireDays}-day expiry` : ''].filter(Boolean).join(', ')})` : b).join(', ')}`)
  return lines
}
