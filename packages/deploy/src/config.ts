/**
 * `deploy.config.ts` — committed with the app, holds no secrets (RFC 0006 §3, §11.2).
 *
 * Targets are plain data (`{ kind: 'pm2', … }`); what each kind does lives in
 * its own module. A config can therefore be printed, diffed and validated
 * without running anything.
 */

export interface DeployConfig {
  /** Owner label: names every process, container, volume, vhost and backup. `[a-z][a-z0-9-]{1,30}`. */
  app: string
  /** The apex the app answers on, e.g. `lexfirma.aipro.ao`. */
  domain: string
  /** `subdomain` → tenants live on `<id>.<domain>`: the wildcard certificate is checked too. */
  tenants?: 'subdomain' | 'none'
  branch?: string
  remote?: string
  env: EnvConfig
  infra?: InfraConfig
  build?: BuildConfig
  migrate?: MigrateConfig
  backup?: BackupConfig
  runtime: RuntimeConfig
  proxy?: ProxyConfig
  health?: HealthConfig
  /**
   * Migration directory names (e.g. `20261011_drop_legacy`) that cannot run
   * under the previous release's code. A release that applies one is never
   * rolled back automatically: the health failure prints the restore command
   * for the pre-migration dump instead (RFC 0006 §8).
   */
  destructive?: string[]
}

export interface EnvConfig {
  /** Relative to the app directory. Written 0600, backed up before every change. */
  file?: string
  /** The module whose import runs the app's `defineEnv(...)`, e.g. `src/env.ts`. */
  schema?: string
  /** Always these values — a different one in the file is corrected. */
  fixed?: Record<string, string>
  /** Generated once when absent, then kept. */
  generate?: Record<string, SecretSpec>
  /** Asked once when absent or empty, then kept. */
  ask?: Record<string, Question>
  /** Computed from the deploy's own values on every run. */
  derive?: (context: DeriveContext) => Record<string, string>
  /** Must not exist in the file at all (e.g. a flag whose "0" would read as true). */
  forbid?: string[]
}

export interface DeriveContext {
  app: string
  domain: string
  port: number
}

export interface SecretSpec {
  kind: 'secret'
  /** Random bytes, written as hex. */
  bytes: number
}

export interface Question {
  kind: 'question'
  prompt: string
  secret: boolean
  /** May be left empty (the app then runs without it, e.g. mail to the log). */
  optional: boolean
  default?: string
}

export type InfraConfig = ExternalInfra | DockerInfra

export interface ExternalInfra {
  kind: 'external'
}

export interface DockerInfra {
  kind: 'docker'
  postgres?: PostgresService
  redis?: RedisService
  minio?: MinioService
}

export interface PostgresService {
  image: string
  /** Host port on 127.0.0.1; `auto` keeps the running container's, else the `.env` URL's, else the first free from 5433. */
  port: number | 'auto'
  user: string
  database: string
  /** The `.env` key that receives the connection URL. */
  urlKey: string
  /** Query parameters appended to the URL (e.g. `{ schema: 'public' }` for Prisma). */
  urlParams: Record<string, string>
}

export interface RedisService {
  image: string
  port: number | 'auto'
  urlKey: string
}

export interface MinioService {
  image: string
  port: number | 'auto'
  consolePort: number | 'auto'
  user: string
  buckets: string[]
  /** The `.env` keys that receive the endpoint and the credentials. */
  keys: { endpoint: string; accessKey: string; secretKey: string }
}

export interface BuildConfig {
  /** Prisma config files, each generated with `prisma generate --config <file>`. */
  prisma?: string[]
  /** Frontend directory built with `<pm> --dir <web> build`. */
  web?: string
}

export interface MigrateConfig {
  /** `prisma migrate deploy` with the root Prisma config. */
  central?: boolean
  /** `<pm> basalt tenant:migrate` (or the given package.json script arguments). */
  tenants?: boolean | string[]
}

export interface BackupConfig {
  beforeMigrate?: boolean
  keep?: number
  /** Relative to the app directory. Default `backups/predeploy`. */
  dir?: string
  /** With external infra: the `.env` key holding the database URL. Default `DATABASE_URL`. */
  urlKey?: string
}

export type RuntimeConfig = Pm2Runtime

export interface Pm2Runtime {
  kind: 'pm2'
  /** Default `<app>-api`. Must start with `<app>-` (RFC 0006 §5, C4). */
  name?: string
  /** package.json script the process runs. */
  script: string
  port: number | 'auto'
  /** Ports never picked by `auto` (e.g. a port the proxy itself listens on). */
  avoid: number[]
}

export type ProxyConfig = ApacheProxy | NoProxy

export interface ApacheProxy {
  kind: 'apache'
  /** File name under `sites-available/`. Default `<app>.conf`. */
  vhost?: string
  /** Directory served as the site's root, relative to the app directory. */
  webRoot: string
  /** Path prefix proxied to the API (stripped). */
  apiPrefix: string
  /** Let's Encrypt certificate name (`/etc/letsencrypt/live/<name>/`). Default: the domain. */
  certName?: string
  /** Default `/etc/apache2`. */
  root?: string
}

export interface NoProxy {
  kind: 'none'
}

export interface HealthConfig {
  /** Path on the API itself (without the proxy prefix). */
  path?: string
  timeoutSeconds?: number
  /** Also check `https://<domain><apiPrefix><path>` — what users reach. */
  public?: boolean
}

// ── helpers used in deploy.config.ts ───────────────────────────────────────

export function defineDeploy(config: DeployConfig): DeployConfig {
  return config
}

export const secret = (bytes = 32): SecretSpec => ({ kind: 'secret', bytes })

export const ask = {
  secret: (prompt: string, options: { optional?: boolean } = {}): Question => ({
    kind: 'question', prompt, secret: true, optional: options.optional ?? false,
  }),
  text: (prompt: string, options: { optional?: boolean; default?: string } = {}): Question => ({
    kind: 'question', prompt, secret: false, optional: options.optional ?? false,
    ...(options.default === undefined ? {} : { default: options.default }),
  }),
}

export const pm2 = (options: { name?: string; script?: string; port?: number | 'auto'; avoid?: number[] } = {}): Pm2Runtime => ({
  kind: 'pm2',
  ...(options.name === undefined ? {} : { name: options.name }),
  script: options.script ?? 'start',
  port: options.port ?? 'auto',
  avoid: options.avoid ?? [],
})

export const apache = (options: { vhost?: string; webRoot?: string; apiPrefix?: string; certName?: string; root?: string } = {}): ApacheProxy => ({
  kind: 'apache',
  ...(options.vhost === undefined ? {} : { vhost: options.vhost }),
  webRoot: options.webRoot ?? 'web/dist',
  apiPrefix: options.apiPrefix ?? '/api',
  ...(options.certName === undefined ? {} : { certName: options.certName }),
  ...(options.root === undefined ? {} : { root: options.root }),
})

export const none = (): NoProxy => ({ kind: 'none' })
export const external = (): ExternalInfra => ({ kind: 'external' })

export const MINIO_IMAGE = 'minio/minio:RELEASE.2025-03-12T18-04-18Z'

export interface DockerInfraOptions {
  postgres?: Partial<PostgresService> | false
  redis?: Partial<RedisService> | false
  minio?: Partial<MinioService> | false
}

/**
 * Dedicated containers on 127.0.0.1 for this app only. Names are fixed by the
 * app label — `<app>-pg`, `<app>-redis`, `<app>-minio` — so a server that
 * already runs them (created by hand or by an older script) is adopted, not
 * duplicated.
 */
export function dockerInfra(app: string, options: DockerInfraOptions = {}): DockerInfra {
  const infra: DockerInfra = { kind: 'docker' }
  if (options.postgres !== false) {
    infra.postgres = {
      image: 'postgres:16', port: 'auto', user: app, database: app, urlKey: 'DATABASE_URL', urlParams: {},
      ...options.postgres,
    }
  }
  if (options.redis !== false) {
    infra.redis = { image: 'redis:7-alpine', port: 'auto', urlKey: 'REDIS_URL', ...options.redis }
  }
  if (options.minio !== false && options.minio !== undefined) {
    infra.minio = {
      image: MINIO_IMAGE, port: 'auto', consolePort: 'auto', user: app, buckets: [],
      keys: { endpoint: 'S3_ENDPOINT', accessKey: 'S3_ACCESS_KEY', secretKey: 'S3_SECRET_KEY' },
      ...options.minio,
    }
  }
  return infra
}

// ── validation and server-local overrides ──────────────────────────────────

export const APP_NAME = /^[a-z][a-z0-9-]{1,30}$/
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

export class DeployConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`deploy.config.ts:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    this.name = 'DeployConfigError'
  }
}

export const processName = (config: DeployConfig) => config.runtime.name ?? `${config.app}-api`
export const vhostName = (config: DeployConfig) =>
  config.proxy?.kind === 'apache' ? (config.proxy.vhost ?? `${config.app}.conf`) : undefined

export function validateConfig(config: DeployConfig): DeployConfig {
  const problems: string[] = []
  if (!APP_NAME.test(config.app)) problems.push(`app "${config.app}" must match ${APP_NAME}`)
  if (!DOMAIN.test(config.domain)) problems.push(`domain "${config.domain}" is not a lowercase host name`)
  // C4: the deploy only ever names what carries the app's label. `pm2 restart
  // all` once was one keystroke away from a production app that is not ours.
  const name = processName(config)
  if (!name.startsWith(`${config.app}-`)) problems.push(`runtime.name "${name}" must start with "${config.app}-" — the deploy only touches what the app owns`)
  if (!/^[a-z0-9-]+$/.test(name)) problems.push(`runtime.name "${name}" may only use a-z, 0-9 and -`)
  const vhost = vhostName(config)
  if (vhost !== undefined && !/^[a-z0-9.-]+\.conf$/.test(vhost)) problems.push(`proxy.vhost "${vhost}" must be a plain *.conf file name`)
  const keys = [
    ...Object.keys(config.env.fixed ?? {}),
    ...Object.keys(config.env.generate ?? {}),
    ...Object.keys(config.env.ask ?? {}),
  ]
  for (const key of keys) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) problems.push(`env key "${key}" is not a valid variable name`)
  for (const key of config.env.forbid ?? []) {
    if (keys.includes(key)) problems.push(`env key "${key}" is both forbidden and set`)
  }
  if (config.infra?.kind === 'docker') {
    const minio = config.infra.minio
    for (const bucket of minio?.buckets ?? []) {
      if (!/^[a-z0-9][a-z0-9.-]{2,62}$/.test(bucket)) problems.push(`bucket "${bucket}" is not a valid S3 bucket name`)
    }
  }
  if (config.backup?.keep !== undefined && (!Number.isInteger(config.backup.keep) || config.backup.keep < 1)) {
    problems.push('backup.keep must be a whole number ≥ 1')
  }
  if (problems.length > 0) throw new DeployConfigError(problems)
  return config
}

/**
 * `/etc/basalt/<app>.json` — what is true of ONE server and so cannot be
 * committed: a port taken there by something else, a branch it tracks. Data
 * only; functions stay in deploy.config.ts.
 */
export interface ServerOverrides {
  domain?: string
  branch?: string
  port?: number
  infra?: { postgres?: { port?: number }; redis?: { port?: number }; minio?: { port?: number; consolePort?: number } }
}

export function applyOverrides(config: DeployConfig, overrides: ServerOverrides): DeployConfig {
  const next: DeployConfig = { ...config }
  if (overrides.domain !== undefined) next.domain = overrides.domain
  if (overrides.branch !== undefined) next.branch = overrides.branch
  if (overrides.port !== undefined) next.runtime = { ...config.runtime, port: overrides.port }
  if (overrides.infra && config.infra?.kind === 'docker') {
    const infra: DockerInfra = { ...config.infra }
    const o = overrides.infra
    if (infra.postgres && o.postgres?.port !== undefined) infra.postgres = { ...infra.postgres, port: o.postgres.port }
    if (infra.redis && o.redis?.port !== undefined) infra.redis = { ...infra.redis, port: o.redis.port }
    if (infra.minio && o.minio) {
      infra.minio = {
        ...infra.minio,
        ...(o.minio.port === undefined ? {} : { port: o.minio.port }),
        ...(o.minio.consolePort === undefined ? {} : { consolePort: o.minio.consolePort }),
      }
    }
    next.infra = infra
  }
  return next
}

export function parseOverrides(text: string, path: string): ServerOverrides {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new DeployConfigError([`${path} is not valid JSON: ${(error as Error).message}`])
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DeployConfigError([`${path} must be a JSON object`])
  }
  const known = new Set(['domain', 'branch', 'port', 'infra'])
  const unknown = Object.keys(value).filter((key) => !known.has(key))
  if (unknown.length > 0) throw new DeployConfigError([`${path}: unknown keys ${unknown.join(', ')} (known: ${[...known].join(', ')})`])
  return value as ServerOverrides
}
