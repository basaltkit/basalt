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
  /**
   * Commands only this app needs, run at fixed points (RFC 0006 §13.3): in the
   * checkout, as the deploy user, with the `.env` values plus `DEPLOY_SHA` and
   * `DEPLOY_APP` in their environment. Idempotent — they run on every deploy.
   */
  hooks?: HooksConfig
}

export interface HooksConfig {
  /** After the `.env` and the infra, before the build. Failing stops the deploy (code put back). */
  infra?: string[][]
  /** After the health check. Failing is a failed release (rolled back). */
  verify?: string[][]
}

export interface EnvConfig {
  /**
   * Relative to the app directory, or absolute (e.g. `/etc/mukanda/api.env`).
   * Written 0600, backed up before every change, in its own directory.
   */
  file?: string
  /** Exact copies of the file (0600), rewritten with it; one that differs is a C10 error. */
  mirror?: string[]
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
  /**
   * The app's own migration command, run in the checkout instead of
   * `central`/`tenants` (e.g. `['./node_modules/.bin/tsx', 'scripts/db.ts', 'deploy']`).
   */
  command?: string[]
  /**
   * Values that override the `.env` for the migration and the pre-migration
   * dump — e.g. URLs that name a container (`@mukanda-postgres:`) rewritten to
   * reach it from the host (`@127.0.0.1:`).
   */
  env?: (values: ReadonlyMap<string, string>) => Record<string, string>
}

export interface BackupConfig {
  beforeMigrate?: boolean
  keep?: number
  /** Relative to the app directory. Default `backups/predeploy`. */
  dir?: string
  /** With external infra: the `.env` key holding the database URL. Default `DATABASE_URL`. */
  urlKey?: string
  /**
   * With external infra: the Postgres container to dump INSIDE (`docker exec`)
   * — the server's own pg_dump major, and no pg_dump needed on the host. The
   * user and database come from the URL at `urlKey`.
   */
  container?: string
}

export type RuntimeConfig = Pm2Runtime | ComposeRuntime

/** A Docker Compose project, its images built per commit (RFC 0006 §13.2). */
export interface ComposeRuntime {
  kind: 'compose'
  /** The compose file, relative to the checkout. */
  file: string
  /** Built as `<tag>:<sha>`; each tag must start with the app name (C4). */
  images: ComposeImage[]
  /** What the proxy reaches on 127.0.0.1: the service and its published port. */
  upstream: { service: string; port: number }
  /** Compose interpolation values (never secrets: they are not in a 0600 file). */
  env: Record<string, string>
  /** Releases whose images are kept for a rollback without a rebuild. */
  keepImages: number
}

export interface ComposeImage {
  tag: string
  dockerfile: string
  /** Build context, relative to the checkout. Default `.`. */
  context?: string
  /** The compose variable that receives `<tag>:<sha>`. */
  env: string
}

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
  /**
   * `false`: the app writes its own vhosts (more than one site, special
   * rules). They are checked on every deploy — C2 (linked, not copied) and C1
   * (every ProxyPass to 127.0.0.1 targets the upstream port) — and never
   * rendered, diffed or written; `install` leaves Apache alone (§13.4).
   */
  managed?: boolean
  /** With `managed: false`: the vhost file names to check. */
  vhosts?: string[]
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

export const apache = (options: { vhost?: string; webRoot?: string; apiPrefix?: string; certName?: string; root?: string; managed?: boolean; vhosts?: string[] } = {}): ApacheProxy => ({
  kind: 'apache',
  ...(options.managed === undefined ? {} : { managed: options.managed }),
  ...(options.vhosts === undefined ? {} : { vhosts: options.vhosts }),
  ...(options.vhost === undefined ? {} : { vhost: options.vhost }),
  webRoot: options.webRoot ?? 'web/dist',
  apiPrefix: options.apiPrefix ?? '/api',
  ...(options.certName === undefined ? {} : { certName: options.certName }),
  ...(options.root === undefined ? {} : { root: options.root }),
})

export const compose = (options: {
  file: string
  images: ComposeImage[]
  upstream: { service: string; port: number }
  env?: Record<string, string>
  keepImages?: number
}): ComposeRuntime => ({
  kind: 'compose',
  file: options.file,
  images: options.images,
  upstream: options.upstream,
  env: options.env ?? {},
  keepImages: options.keepImages ?? 3,
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

/** The PM2 process name (`<app>-api` by default). Compose names its own containers. */
export const processName = (config: DeployConfig) =>
  config.runtime.kind === 'pm2' ? (config.runtime.name ?? `${config.app}-api`) : config.app
export const vhostName = (config: DeployConfig) =>
  config.proxy?.kind === 'apache' ? (config.proxy.vhost ?? `${config.app}.conf`) : undefined

export function validateConfig(config: DeployConfig): DeployConfig {
  const problems: string[] = []
  if (!APP_NAME.test(config.app)) problems.push(`app "${config.app}" must match ${APP_NAME}`)
  if (!DOMAIN.test(config.domain)) problems.push(`domain "${config.domain}" is not a lowercase host name`)
  // C4: the deploy only ever names what carries the app's label. `pm2 restart
  // all` once was one keystroke away from a production app that is not ours.
  if (config.runtime.kind === 'pm2') {
    const name = processName(config)
    if (!name.startsWith(`${config.app}-`)) problems.push(`runtime.name "${name}" must start with "${config.app}-" — the deploy only touches what the app owns`)
    if (!/^[a-z0-9-]+$/.test(name)) problems.push(`runtime.name "${name}" may only use a-z, 0-9 and -`)
  } else {
    const rt = config.runtime
    if (rt.images.length === 0) problems.push('runtime.images: at least one image')
    for (const image of rt.images) {
      // C4: an image tag outside the app's name could prune another app's images.
      if (image.tag !== config.app && !image.tag.startsWith(`${config.app}-`)) problems.push(`runtime image "${image.tag}" must be "${config.app}" or start with "${config.app}-" — the deploy only touches what the app owns`)
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(image.tag)) problems.push(`runtime image "${image.tag}" is not a plain image name (no registry, no tag)`)
      if (!/^[A-Z_][A-Z0-9_]*$/.test(image.env)) problems.push(`runtime image env "${image.env}" is not a variable name`)
    }
    if (new Set(rt.images.map((i) => i.tag)).size !== rt.images.length) problems.push('runtime.images: each tag once')
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(rt.upstream.service)) problems.push(`runtime.upstream.service "${rt.upstream.service}" is not a compose service name`)
    if (!Number.isInteger(rt.upstream.port) || rt.upstream.port < 1 || rt.upstream.port > 65535) problems.push('runtime.upstream.port must be a port number')
    if (!Number.isInteger(rt.keepImages) || rt.keepImages < 1) problems.push('runtime.keepImages must be a whole number ≥ 1')
    for (const key of Object.keys(rt.env)) if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) problems.push(`runtime.env key "${key}" is not a variable name`)
  }
  if (config.proxy?.kind === 'apache' && config.proxy.managed === false) {
    const vhosts = config.proxy.vhosts ?? []
    if (vhosts.length === 0) problems.push('proxy.vhosts: name the vhost files to check when managed is false')
    for (const v of vhosts) if (!/^[a-z0-9.-]+\.conf$/.test(v)) problems.push(`proxy.vhosts "${v}" must be a plain *.conf file name`)
  }
  for (const hook of [...(config.hooks?.infra ?? []), ...(config.hooks?.verify ?? [])]) {
    if (!Array.isArray(hook) || hook.length === 0 || hook.some((part) => typeof part !== 'string')) problems.push('hooks: each hook is a non-empty array of strings (a command and its arguments)')
  }
  if (config.migrate?.command && config.migrate.command.length === 0) problems.push('migrate.command must not be empty')
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
  if (config.backup?.container !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(config.backup.container)) {
    problems.push(`backup.container "${config.backup.container}" is not a container name`)
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
  if (overrides.port !== undefined) {
    next.runtime = config.runtime.kind === 'pm2'
      ? { ...config.runtime, port: overrides.port }
      : { ...config.runtime, upstream: { ...config.runtime.upstream, port: overrides.port } }
  }
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
