/**
 * `deploy.config.ts` — committed with the app, holds no secrets (RFC 0006 §3, §11.2).
 *
 * Targets are plain data (`{ kind: 'pm2', … }`); what each kind does lives in
 * its own module. A config can therefore be printed, diffed and validated
 * without running anything.
 */

/**
 * The app's environment, as `defineEnv` returns it: `defineDeploy<typeof env>`
 * with `import type { env } from './src/env.js'` types every `.env` key the
 * config names (RFC 0007 §2.1). Type-only — the app is never loaded.
 */
export type EnvShape = Record<string, unknown>

/** A key of the app's `.env`: any string until `defineDeploy<typeof env>` narrows it. */
export type EnvKey<E extends object = EnvShape> = Extract<keyof E, string>

/**
 * What a `.env` line may hold for a value of type `T`: an enum's members, a
 * number's digits, `true`/`false` — else any string.
 */
export type EnvValue<T> = ValueOf<T & {}>

type ValueOf<N> =
  [N] extends [never] ? string
    : N extends string ? (string extends N ? string : N)
      : N extends number ? `${number}`
        : N extends boolean ? 'true' | 'false'
          : string

export interface DeployConfig<E extends object = EnvShape> {
  /**
   * Owner label: names every process, container, volume, vhost and backup.
   * `[a-z][a-z0-9-]{1,30}`.
   * @example 'acme'
   */
  app: string
  /**
   * The apex the app answers on.
   * @example 'acme.example.com'
   */
  domain: string
  /**
   * `subdomain` → tenants live on `<id>.<domain>`: the wildcard certificate is checked too.
   * @default 'none'
   */
  tenants?: 'subdomain' | 'none'
  /**
   * The branch a deploy fetches and fast-forwards to.
   * @default 'main'
   */
  branch?: string
  /** @default 'origin' */
  remote?: string
  /** The `.env`: where it lives and what the deploy keeps in it. */
  env: EnvConfig<E>
  /** Databases, caches and object storage: `dockerInfra(app)` or `external()`. */
  infra?: InfraConfig<E>
  build?: BuildConfig
  migrate?: MigrateConfig<E>
  /** The `pg_dump` before migrating (RFC 0006 §8). */
  backup?: BackupConfig<E>
  /** How the app runs: `pm2({ … })` or `compose({ … })`. */
  runtime: RuntimeConfig
  /** What sits in front: `apache({ … })` or `none()`. Default: none. */
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
  /** Declarative checks after the health check; a failure is a failed release, rolled back (RFC 0007 §6). */
  verify?: VerifyConfig
  /** What `basalt-deploy bootstrap` sets up on a fresh server (RFC 0007 §7). */
  bootstrap?: {
    /** Swap created when RAM is under 6 GB and there is none; 0 = never. @default 4 */
    swapGb?: number
    /** ufw: SSH (+ 80/443 behind a proxy), turned on only when nothing else listens. @default true */
    firewall?: boolean
  }
}

export interface VerifyConfig {
  /**
   * Per compose service, text that must not appear in its logs since the
   * release started — a worker that cannot reach its queue logs, it does not crash.
   * @example { 'ingest-worker': ['EAI_AGAIN', 'ECONNREFUSED'] }
   */
  logs?: Record<string, string[]>
  /**
   * More URLs on the API than `health.path`, each answering `expect` (default 200).
   * @example [{ path: '/readyz' }]
   */
  http?: Array<{ path: `/${string}`; expect?: number }>
}

export interface HooksConfig {
  /** After the `.env` and the infra, before the build. Failing stops the deploy (code put back). */
  infra?: string[][]
  /** After the health check. Failing is a failed release (rolled back). */
  verify?: string[][]
}

export interface EnvConfig<E extends object = EnvShape> {
  /**
   * Relative to the app directory, or absolute. Written 0600, backed up
   * before every change, in its own directory.
   * @default '.env'
   * @example '/etc/globex/api.env'
   */
  file?: string
  /** Exact copies of the file (0600), rewritten with it; one that differs is a C10 error. */
  mirror?: string[]
  /**
   * The module whose import runs the app's `defineEnv(...)`; the new `.env`
   * is validated against it before migrating.
   * @example 'src/env.ts'
   */
  schema?: string
  /**
   * Always these values — a different one in the file is corrected.
   * @example { NODE_ENV: 'production' }
   */
  fixed?: { [K in EnvKey<E>]?: EnvValue<E[K]> }
  /**
   * Generated once when absent, then kept.
   * @example { APP_SECRET: secret(32) }
   */
  generate?: { [K in EnvKey<E>]?: SecretSpec }
  /**
   * Asked once when absent or empty, then kept.
   * @example { SMTP_URL: ask('SMTP URL', { secret: true }) }
   */
  ask?: { [K in EnvKey<E>]?: Question }
  /** Computed from the deploy's own values on every run. */
  derive?: (context: DeriveContext) => { [K in EnvKey<E>]?: string }
  /**
   * Must not exist in the file at all (e.g. a flag whose "0" would read as
   * true). Usually keys the schema no longer has, so any string.
   */
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

export type InfraConfig<E extends object = EnvShape> = ExternalInfra<E> | DockerInfra<E>

/**
 * Containers this deploy does not create (their data outlives any release),
 * but keeps: checked running in the preflight, the app's database role and the
 * buckets maintained on every deploy, the database dumped before migrating
 * (RFC 0007 §4.5). Without services, `external()` means "nothing to do".
 */
export interface ExternalInfra<E extends object = EnvShape> {
  kind: 'external'
  postgres?: ExternalPostgres<E>
  redis?: { container: string }
  minio?: { container: string; buckets?: Bucket[] }
}

export interface ExternalPostgres<E extends object = EnvShape> {
  container: string
  /**
   * The `.env` key with the OWNER's URL (user, password, database): what the
   * role, the grants and the dump run as.
   * @default 'DATABASE_URL'
   */
  urlKey?: EnvKey<E>
  appRole?: AppRole<E>
}

/**
 * The role the app connects as: no DDL, no superuser (RFC 0007 §4.1). Created
 * when missing, its password kept equal to the URL at `urlKey` (generated
 * there when absent), and granted DML through the owner's default privileges.
 */
export interface AppRole<E extends object = EnvShape> {
  /** @example 'globex_app' */
  name: string
  /** The `.env` key with the app's URL. */
  urlKey: EnvKey<E>
}

/**
 * A bucket name, or one with its policy: `versioned` turns versioning on,
 * `expireDays` adds an expiry rule — once (RFC 0007 §4.2).
 */
export type Bucket = string | { name: string; versioned?: boolean; expireDays?: number }

export interface DockerInfra<E extends object = EnvShape> {
  kind: 'docker'
  postgres?: PostgresService<E>
  redis?: RedisService<E>
  minio?: MinioService
  /**
   * The compose project the containers belong to. Default: the app — what an
   * older compose file of the app's infra already used. An app whose own
   * runtime is a compose project named after it needs another one.
   * @example 'myapp-infra'
   */
  project?: string
  /**
   * Who reaches the services through the URLs written to the `.env`:
   * `host` — a process on the host (PM2): `127.0.0.1:<published port>`;
   * `containers` — the app's containers: `<container>:<internal port>`, on
   * the networks `runtime.attach` connects them to. Migrations and the dump,
   * which run on the host, get the `127.0.0.1` form either way.
   * @default 'host'
   */
  access?: 'host' | 'containers'
}

export interface PostgresService<E extends object = EnvShape> {
  image: string
  /** Host port on 127.0.0.1; `auto` keeps the running container's, else the `.env` URL's, else the first free from 5433. */
  port: number | 'auto'
  user: string
  database: string
  /**
   * The `.env` key that receives the connection URL.
   * @default 'DATABASE_URL'
   */
  urlKey: EnvKey<E>
  /** Query parameters appended to the URL (e.g. `{ schema: 'public' }` for Prisma). */
  urlParams: Record<string, string>
  /** Adopt a container under another name. Default `<app>-pg`. */
  container?: string
  appRole?: AppRole<E>
}

export interface RedisService<E extends object = EnvShape> {
  image: string
  port: number | 'auto'
  /** @default 'REDIS_URL' */
  urlKey: EnvKey<E>
  /** Adopt a container under another name. Default `<app>-redis`. */
  container?: string
}

export interface MinioService {
  image: string
  port: number | 'auto'
  consolePort: number | 'auto'
  user: string
  buckets: Bucket[]
  /** The `.env` keys that receive the endpoint and the credentials. */
  keys: { endpoint: string; accessKey: string; secretKey: string }
  /** Adopt a container under another name. Default `<app>-minio`. */
  container?: string
}

export interface BuildConfig {
  /** Prisma config files, each generated with `prisma generate --config <file>`. */
  prisma?: string[]
  /**
   * The package.json script that compiles the app, run after `prisma
   * generate` — needed when `start` runs the compiled output (`node dist/…`),
   * as a create-basalt app's does.
   * @example 'build'
   */
  script?: string
  /** Frontend directory built with `<pm> --dir <web> build`. */
  web?: string
}

export interface MigrateConfig<E extends object = EnvShape> {
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
   * dump — e.g. URLs that name a container (`@globex-postgres:`) rewritten to
   * reach it from the host (`@127.0.0.1:`).
   */
  env?: (values: ReadonlyMap<EnvKey<E>, string>) => { [K in EnvKey<E>]?: string }
}

export interface BackupConfig<E extends object = EnvShape> {
  /**
   * Unsaid: the dump runs when something is migrated and there is a Postgres
   * to dump. `true`/`false` force it either way.
   */
  beforeMigrate?: boolean
  /**
   * Dumps kept; older ones are removed.
   * @default 10
   */
  keep?: number
  /**
   * Relative to the app directory.
   * @default 'backups/predeploy'
   */
  dir?: string
  /**
   * With external infra: the `.env` key holding the database URL.
   * @default 'DATABASE_URL'
   */
  urlKey?: EnvKey<E>
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
  /**
   * `.env` keys handed to compose for interpolation (`${KEY}` in the file) —
   * a service without `env_file` that still needs one value, a password among
   * them. In compose's environment only: never on a command line, never in a file.
   * @example ['MYAPP_REDIS_URL']
   */
  passEnv?: string[]
  /**
   * Containers this project does not own, connected to its networks before
   * `up` — creating the project first on a fresh server, so the first release
   * is healthy, not the second (RFC 0007 §4.3).
   * @example { 'myapp-postgres': ['data'], 'myapp-redis': ['data', 'sandbox'] }
   */
  attach?: Record<string, string[]>
  /** One-off commands before `up`, with this commit's images (RFC 0007 §4.4). */
  jobs?: ComposeJob[]
}

export interface ComposeJob {
  /** A service of the compose file; the job runs `docker compose run --rm --no-deps <service> …`. */
  service: string
  /** The command; default the service's own. */
  command?: string[]
  /**
   * Skip the job when this path (a glob, inside the service's container)
   * already exists — e.g. signatures already in a volume.
   * @example { exists: '/var/lib/clamav/main.c?d' }
   */
  once?: { exists: string }
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

export type ProxyConfig = ApacheProxy | CaddyProxy | NoProxy

/**
 * Caddy on the host (RFC 0007 §8): `install` writes `/etc/caddy/sites/<app>.caddy`
 * (imported by the main Caddyfile) and reloads after `caddy validate`; deploys
 * diff it and never rewrite it. TLS is Caddy's own: one certificate per host,
 * issued on first visit — for tenants, only once the app says the host is
 * theirs (`onDemandTls.ask`).
 */
export interface CaddyProxy {
  kind: 'caddy'
  /** Directory served at `/`, relative to the app directory. @default 'web/dist' */
  webRoot: string
  /** Path prefix proxied to the API (stripped). @default '/api' */
  apiPrefix: string
  /**
   * Issue certificates on demand, after asking the app (`GET <ask>?domain=<host>`
   * answering 200) — required for `tenants: 'subdomain'` and customer domains.
   * Caddy has one such endpoint per server: it lives in the main Caddyfile.
   * @example { ask: '/tls/allowed' }
   */
  onDemandTls?: { ask: `/${string}` }
  /** More Caddyfile appended to the site file, as is (another host of the app, special routes). */
  extra?: string
  /** `false`: the site file is the app's own — checked (imported, C1), never written. */
  managed?: boolean
  /** @default '/etc/caddy' */
  root?: string
}

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
  /**
   * Path on the API itself (without the proxy prefix).
   * @default '/health'
   * @example '/readyz'
   */
  path?: `/${string}`
  /**
   * How long the release may take to answer before it is rolled back.
   * @default 60
   */
  timeoutSeconds?: number
  /**
   * Also check `https://<domain><apiPrefix><path>` — what users reach.
   * @default true with a proxy
   */
  public?: boolean
}

/** The entries of an env record, without the keys a mapped type left `undefined`. */
export function definedEntries<T>(record: { readonly [key: string]: T | undefined } | undefined): [string, T][] {
  return Object.entries(record ?? {}).filter((entry): entry is [string, T] => entry[1] !== undefined)
}

// ── helpers used in deploy.config.ts ───────────────────────────────────────

/**
 * Types `deploy.config.ts`. With the app's env, every `.env` key the config
 * names is completed and checked (RFC 0007 §2.1):
 *
 * ```ts
 * import type { env } from './src/env.js'
 * export default defineDeploy<typeof env>({ … })
 * ```
 */
export function defineDeploy<E extends object = EnvShape>(config: NoInfer<DeployConfig<E>>): DeployConfig<E> {
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

export const caddy = (options: { webRoot?: string; apiPrefix?: string; onDemandTls?: { ask: `/${string}` }; extra?: string; managed?: boolean; root?: string } = {}): CaddyProxy => ({
  kind: 'caddy',
  webRoot: options.webRoot ?? 'web/dist',
  apiPrefix: options.apiPrefix ?? '/api',
  ...(options.onDemandTls ? { onDemandTls: options.onDemandTls } : {}),
  ...(options.extra === undefined ? {} : { extra: options.extra }),
  ...(options.managed === undefined ? {} : { managed: options.managed }),
  ...(options.root === undefined ? {} : { root: options.root }),
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
  attach?: Record<string, string[]>
  jobs?: ComposeJob[]
  passEnv?: string[]
}): ComposeRuntime => ({
  kind: 'compose',
  file: options.file,
  images: options.images,
  upstream: options.upstream,
  env: options.env ?? {},
  keepImages: options.keepImages ?? 3,
  ...(options.attach ? { attach: options.attach } : {}),
  ...(options.jobs ? { jobs: options.jobs } : {}),
  ...(options.passEnv ? { passEnv: options.passEnv } : {}),
})

export const none = (): NoProxy => ({ kind: 'none' })
export const external = <E extends object = EnvShape>(services: NoInfer<Omit<ExternalInfra<E>, 'kind'>> = {}): ExternalInfra<E> => ({ kind: 'external', ...services })

/** A bucket's name, whichever form it was given in. */
export const bucketName = (bucket: Bucket): string => (typeof bucket === 'string' ? bucket : bucket.name)

export const MINIO_IMAGE = 'minio/minio:RELEASE.2025-03-12T18-04-18Z'

export interface DockerInfraOptions<E extends object = EnvShape> {
  project?: string
  access?: 'host' | 'containers'
  postgres?: Partial<PostgresService<E>> | false
  redis?: Partial<RedisService<E>> | false
  minio?: Partial<MinioService> | false
}

/**
 * Dedicated containers on 127.0.0.1 for this app only. Names are fixed by the
 * app label — `<app>-pg`, `<app>-redis`, `<app>-minio` — so a server that
 * already runs them (created by hand or by an older script) is adopted, not
 * duplicated.
 */
export function dockerInfra<E extends object = EnvShape>(app: string, options: NoInfer<DockerInfraOptions<E>> = {}): DockerInfra<E> {
  const infra: DockerInfra<E> = { kind: 'docker', ...(options.project ? { project: options.project } : {}), ...(options.access ? { access: options.access } : {}) }
  if (options.postgres !== false) {
    infra.postgres = {
      image: 'postgres:16', port: 'auto', user: app, database: app, urlKey: 'DATABASE_URL' as EnvKey<E>, urlParams: {},
      ...options.postgres,
    }
  }
  if (options.redis !== false) {
    infra.redis = { image: 'redis:7-alpine', port: 'auto', urlKey: 'REDIS_URL' as EnvKey<E>, ...options.redis }
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
/** A git remote name: never an option (`-…`), never a URL or a path. */
export const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * `git check-ref-format --branch`, narrowed to the characters a branch name
 * needs — and never a leading `-`, which git would read as an option
 * (`--upload-pack=…` runs a command).
 */
export function isBranchName(name: unknown): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) return false
  if (!/^[A-Za-z0-9._/+-]+$/.test(name)) return false
  if (/^[-/.]/.test(name) || /[/.]$/.test(name) || name.endsWith('.lock')) return false
  return !/\.\.|\/\/|\/\.|\.lock\//.test(name)
}

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

export function validateConfig<E extends object = EnvShape>(typed: DeployConfig<E>): DeployConfig<E> {
  // The checks read keys as plain strings; the app's key types are for the editor.
  const config = typed as unknown as DeployConfig
  const problems: string[] = []
  if (!APP_NAME.test(config.app)) problems.push(`app "${config.app}" must match ${APP_NAME}`)
  if (!DOMAIN.test(config.domain)) problems.push(`domain "${config.domain}" is not a lowercase host name`)
  if (config.branch !== undefined && !isBranchName(config.branch)) problems.push(`branch "${String(config.branch)}" is not a plain git branch name (no leading "-", no "..", letters, digits, . _ / + - only)`)
  if (config.remote !== undefined && !REMOTE_NAME.test(config.remote)) problems.push(`remote "${String(config.remote)}" is not a git remote name (${REMOTE_NAME})`)
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
      if (!/^[a-z0-9][a-z0-9.-]{2,62}$/.test(bucketName(bucket))) problems.push(`bucket "${bucketName(bucket)}" is not a valid S3 bucket name`)
    }
  }
  const services = config.infra?.kind === 'external' ? config.infra : undefined
  for (const bucket of services?.minio?.buckets ?? []) {
    if (!/^[a-z0-9][a-z0-9.-]{2,62}$/.test(bucketName(bucket))) problems.push(`bucket "${bucketName(bucket)}" is not a valid S3 bucket name`)
  }
  for (const bucket of [...(services?.minio?.buckets ?? []), ...(config.infra?.kind === 'docker' ? config.infra.minio?.buckets ?? [] : [])]) {
    if (typeof bucket === 'object' && bucket.expireDays !== undefined && (!Number.isInteger(bucket.expireDays) || bucket.expireDays < 1)) {
      problems.push(`bucket "${bucket.name}": expireDays must be a whole number ≥ 1`)
    }
  }
  const containers = [
    services?.postgres?.container, services?.redis?.container, services?.minio?.container,
    ...(config.infra?.kind === 'docker' ? [config.infra.postgres?.container, config.infra.redis?.container, config.infra.minio?.container] : []),
  ]
  for (const container of containers) {
    if (container !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container)) problems.push(`container "${container}" is not a container name`)
  }
  if (config.infra?.kind === 'docker' && config.infra.project !== undefined && !/^[a-z0-9][a-z0-9_-]*$/.test(config.infra.project)) {
    problems.push(`infra.project "${config.infra.project}" is not a compose project name`)
  }
  if (config.infra?.kind === 'docker' && (config.infra.project ?? config.app) === config.app && config.runtime.kind === 'compose') {
    problems.push(`infra.project "${config.app}" is the runtime's compose project too: the two would remove each other's containers as orphans — use "${config.app}-infra"`)
  }
  const role = services?.postgres?.appRole ?? (config.infra?.kind === 'docker' ? config.infra.postgres?.appRole : undefined)
  if (role && !/^[a-z_][a-z0-9_]{0,62}$/.test(role.name)) problems.push(`appRole "${role.name}" must be a lowercase Postgres identifier`)
  if (config.backup?.keep !== undefined && (!Number.isInteger(config.backup.keep) || config.backup.keep < 1)) {
    problems.push('backup.keep must be a whole number ≥ 1')
  }
  if (config.backup?.container !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(config.backup.container)) {
    problems.push(`backup.container "${config.backup.container}" is not a container name`)
  }
  if (config.proxy?.kind === 'caddy' && config.tenants === 'subdomain' && !config.proxy.onDemandTls) {
    problems.push(`tenants: 'subdomain' behind caddy() needs onDemandTls: { ask: '/…' } — a certificate per tenant host, issued only for hosts the app vouches for`)
  }
  if (problems.length > 0) throw new DeployConfigError(problems)
  return typed
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
