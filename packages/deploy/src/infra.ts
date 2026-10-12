import { join } from 'node:path'
import type { DockerInfra } from './config.js'
import { DeployError, type DeployContext, type Finding } from './context.js'
import type { EnvChange } from './dotenv.js'
import { freePort } from './ports.js'
import { appRoleEnv, appRoleOf, ensureAppRole, ensureBuckets, externalFindings, externalOf, externalPostgres, minioHandle, type PostgresHandle } from './services.js'

/**
 * Dedicated containers, adopted or created (RFC 0006 §6.3).
 *
 * The running container is the truth: its credentials are read back and the
 * `.env` follows them, never the other way round. A fresh password written over
 * an initialised volume is exactly the `P1000` that cost a production deploy
 * (incident 7) — Postgres and MinIO keep the first credentials in the data.
 *
 * Passwords never reach a command line (visible in `ps`) or the generated
 * compose file: compose reads them from its own environment, and `docker exec
 * -e NAME` (no value) copies them from the CLI's environment.
 */

export type ServiceName = 'postgres' | 'redis' | 'minio'

export interface ServicePlan {
  service: ServiceName
  container: string
  volume: string
  action: 'adopt' | 'create'
  port: number
  consolePort?: number
  user?: string
  database?: string
  /** Where the password came from — printed; the password itself never is. */
  source: 'container' | 'env' | 'generated'
}

export interface InfraPlan {
  services: ServicePlan[]
  env: EnvChange[]
  findings: Finding[]
  /** Values compose interpolates (`${BASALT_PG_PASSWORD}`); passed in its environment only. */
  secrets: Record<string, string>
  /** The dedicated Postgres's owner URL, as the `.env` will hold it (the app role's is derived from it). */
  ownerUrl?: string
}

interface Inspected {
  env: Map<string, string>
  ports: Map<string, number>
}

async function inspect(ctx: DeployContext, container: string): Promise<Inspected | undefined> {
  const result = await ctx.host.exec('docker', ['inspect', container, '--format', '{{json .Config.Env}}\t{{json .HostConfig.PortBindings}}'])
  if (result.code !== 0) return undefined
  const [envJson = '[]', portsJson = '{}'] = result.stdout.trim().split('\t')
  const env = new Map<string, string>()
  for (const entry of JSON.parse(envJson) as string[]) {
    const eq = entry.indexOf('=')
    if (eq > 0) env.set(entry.slice(0, eq), entry.slice(eq + 1))
  }
  const ports = new Map<string, number>()
  const bindings = (JSON.parse(portsJson) ?? {}) as Record<string, Array<{ HostPort?: string }> | null>
  for (const [containerPort, hostPorts] of Object.entries(bindings)) {
    const hostPort = Number(hostPorts?.[0]?.HostPort)
    if (Number.isInteger(hostPort) && hostPort > 0) ports.set(containerPort, hostPort)
  }
  return { env, ports }
}

async function volumeExists(ctx: DeployContext, volume: string): Promise<boolean> {
  return (await ctx.host.exec('docker', ['volume', 'inspect', volume])).code === 0
}

function urlParts(value: string | undefined): { user: string; password: string; port: number; database: string } | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return undefined
    return {
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      port: Number(url.port),
      database: url.pathname.replace(/^\//, ''),
    }
  } catch {
    return undefined
  }
}

const names = (app: string, service: ServiceName, container?: string) => {
  const suffix = service === 'postgres' ? 'pg' : service
  // Compose prefixes volumes with the project name — the app — so this is
  // what an older compose file with the same project name already created.
  return { container: container ?? `${app}-${suffix}`, volumeKey: `${app}-${suffix}-data`, volume: `${app}_${app}-${suffix}-data` }
}

export async function planInfra(ctx: DeployContext, values: Map<string, string>): Promise<InfraPlan> {
  const infra = ctx.config.infra
  const plan: InfraPlan = { services: [], env: [], findings: [], secrets: {} }
  if (infra?.kind === 'external') {
    plan.findings.push(...await externalFindings(ctx))
    const pg = infra.postgres
    if (pg) plan.env.push(...appRoleEnv(ctx, values, values.get(pg.urlKey ?? 'DATABASE_URL')))
    return plan
  }
  if (infra?.kind !== 'docker') return plan
  const { app } = ctx.config
  const picked: number[] = []
  const pick = async (wanted: number | 'auto', existing: number | undefined, from: number) => {
    const port = typeof wanted === 'number' ? wanted : existing ?? await freePort(ctx.host, from, [], picked)
    picked.push(port)
    return port
  }
  const setEnv = (key: string, value: string, reason: string) => {
    if (values.get(key) !== value) plan.env.push({ kind: 'set', key, value, reason })
  }
  const unknownPassword = (service: ServiceName, volume: string): Finding => ({
    id: 'C7',
    level: 'error',
    message: `${service}: the volume ${volume} exists but no container and no .env value says which password it was initialised with`,
    fix: `put the original credentials back in ${ctx.config.env.file ?? '.env'}, or — destroying that data — docker volume rm ${volume}`,
  })

  if (infra.postgres) {
    const pg = infra.postgres
    const { container, volume } = names(app, 'postgres', pg.container)
    const running = await inspect(ctx, container)
    const fromEnv = urlParts(values.get(pg.urlKey))
    let password = running?.env.get('POSTGRES_PASSWORD')
    let source: ServicePlan['source'] = 'container'
    if (password === undefined && fromEnv?.password) { password = fromEnv.password; source = 'env' }
    if (password === undefined) {
      if (await volumeExists(ctx, volume)) plan.findings.push(unknownPassword('postgres', volume))
      password = ctx.host.randomHex(24)
      source = 'generated'
    }
    const user = running?.env.get('POSTGRES_USER') ?? fromEnv?.user ?? pg.user
    const database = running?.env.get('POSTGRES_DB') ?? fromEnv?.database ?? pg.database
    const port = await pick(pg.port, running?.ports.get('5432/tcp') ?? fromEnv?.port, 5433)
    const params = new URLSearchParams(pg.urlParams).toString()
    plan.ownerUrl = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}${params ? `?${params}` : ''}`
    setEnv(pg.urlKey, plan.ownerUrl,
      source === 'container' ? `from the running ${container}` : source === 'generated' ? 'new database' : 'port or parameters')
    plan.env.push(...appRoleEnv(ctx, values, plan.ownerUrl))
    plan.secrets['BASALT_PG_PASSWORD'] = password
    plan.services.push({ service: 'postgres', container, volume, action: running ? 'adopt' : 'create', port, user, database, source })
  }

  if (infra.redis) {
    const redis = infra.redis
    const { container, volume } = names(app, 'redis', redis.container)
    const running = await inspect(ctx, container)
    const fromEnv = urlParts(values.get(redis.urlKey))
    let password = running?.env.get('REDIS_PASSWORD')
    let source: ServicePlan['source'] = 'container'
    if (password === undefined && fromEnv?.password) { password = fromEnv.password; source = 'env' }
    // Redis keeps no credentials in its data: a new password is always safe.
    if (password === undefined) { password = ctx.host.randomHex(24); source = 'generated' }
    const port = await pick(redis.port, running?.ports.get('6379/tcp') ?? fromEnv?.port, 6380)
    setEnv(redis.urlKey, `redis://:${encodeURIComponent(password)}@127.0.0.1:${port}`,
      source === 'container' ? `from the running ${container}` : source === 'generated' ? 'new redis' : 'port')
    plan.secrets['BASALT_REDIS_PASSWORD'] = password
    plan.services.push({ service: 'redis', container, volume, action: running ? 'adopt' : 'create', port, source })
  }

  if (infra.minio) {
    const minio = infra.minio
    const { container, volume } = names(app, 'minio', minio.container)
    const running = await inspect(ctx, container)
    let user = running?.env.get('MINIO_ROOT_USER')
    let password = running?.env.get('MINIO_ROOT_PASSWORD')
    let source: ServicePlan['source'] = 'container'
    if ((user === undefined || password === undefined) && values.get(minio.keys.secretKey)) {
      user = values.get(minio.keys.accessKey) ?? minio.user
      password = values.get(minio.keys.secretKey) as string
      source = 'env'
    }
    if (user === undefined || password === undefined) {
      if (await volumeExists(ctx, volume)) plan.findings.push(unknownPassword('minio', volume))
      user = minio.user
      password = ctx.host.randomHex(24)
      source = 'generated'
    }
    let endpointPort: number | undefined
    try {
      const endpoint = values.get(minio.keys.endpoint)
      endpointPort = endpoint ? Number(new URL(endpoint).port) || undefined : undefined
    } catch {
      endpointPort = undefined
    }
    const port = await pick(minio.port, running?.ports.get('9000/tcp') ?? endpointPort, 9100)
    const consolePort = await pick(minio.consolePort, running?.ports.get('9001/tcp'), port + 1)
    const reason = source === 'container' ? `from the running ${container}` : source === 'generated' ? 'new minio' : 'port'
    setEnv(minio.keys.endpoint, `http://127.0.0.1:${port}`, reason)
    setEnv(minio.keys.accessKey, user, reason)
    setEnv(minio.keys.secretKey, password, reason)
    plan.secrets['BASALT_MINIO_USER'] = user
    plan.secrets['BASALT_MINIO_PASSWORD'] = password
    plan.services.push({ service: 'minio', container, volume, action: running ? 'adopt' : 'create', port, consolePort, user, source })
  }
  return plan
}

/** The compose file, with no secret in it: compose interpolates them from its environment. */
export function renderCompose(app: string, infra: DockerInfra, plan: InfraPlan): string {
  for (const service of plan.services) {
    for (const value of [service.user, service.database]) {
      // These go into the YAML as written: anything outside an identifier
      // could change its meaning.
      if (value !== undefined && !/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/.test(value)) {
        throw new Error(`${service.service}: "${value}" is not a plain user/database name; rename it in deploy.config.ts`)
      }
    }
  }
  const lines = [
    `# Generated by basalt-deploy for "${app}". Do not edit — change deploy.config.ts.`,
    '# Every port is bound to 127.0.0.1: Docker writes its own iptables rules and',
    '# ignores ufw, so a port published without an address is open to the internet.',
    `name: ${app}`,
    '',
    'services:',
  ]
  const volumes: string[] = []
  for (const service of plan.services) {
    const key = service.volume.slice(app.length + 1)
    volumes.push(key)
    if (service.service === 'postgres' && infra.postgres) {
      lines.push(
        '  postgres:',
        `    image: ${infra.postgres.image}`,
        `    container_name: ${service.container}`,
        '    restart: unless-stopped',
        `    labels: { basalt.app: ${app} }`,
        `    ports: ['127.0.0.1:${service.port}:5432']`,
        '    environment:',
        `      POSTGRES_USER: ${service.user}`,
        '      POSTGRES_PASSWORD: ${BASALT_PG_PASSWORD:?missing}',
        `      POSTGRES_DB: ${service.database}`,
        `    volumes: ['${key}:/var/lib/postgresql/data']`,
        '    healthcheck:',
        `      test: ['CMD-SHELL', 'pg_isready -U ${service.user} -d ${service.database}']`,
        '      interval: 10s',
        '      timeout: 5s',
        '      retries: 10',
      )
    }
    if (service.service === 'redis' && infra.redis) {
      lines.push(
        '  redis:',
        `    image: ${infra.redis.image}`,
        `    container_name: ${service.container}`,
        '    restart: unless-stopped',
        `    labels: { basalt.app: ${app} }`,
        "    command: ['sh', '-c', 'exec redis-server --requirepass \"$$REDIS_PASSWORD\" --appendonly yes']",
        `    ports: ['127.0.0.1:${service.port}:6379']`,
        '    environment:',
        '      REDIS_PASSWORD: ${BASALT_REDIS_PASSWORD:?missing}',
        `    volumes: ['${key}:/data']`,
        '    healthcheck:',
        `      test: ['CMD-SHELL', 'REDISCLI_AUTH="$$REDIS_PASSWORD" redis-cli ping | grep -q PONG']`,
        '      interval: 10s',
        '      timeout: 5s',
        '      retries: 10',
      )
    }
    if (service.service === 'minio' && infra.minio) {
      lines.push(
        '  minio:',
        `    image: ${infra.minio.image}`,
        `    container_name: ${service.container}`,
        '    restart: unless-stopped',
        `    labels: { basalt.app: ${app} }`,
        "    command: ['server', '/data', '--console-address', ':9001']",
        `    ports: ['127.0.0.1:${service.port}:9000', '127.0.0.1:${service.consolePort}:9001']`,
        '    environment:',
        '      MINIO_ROOT_USER: ${BASALT_MINIO_USER:?missing}',
        '      MINIO_ROOT_PASSWORD: ${BASALT_MINIO_PASSWORD:?missing}',
        `    volumes: ['${key}:/data']`,
        '    healthcheck:',
        "      test: ['CMD', 'mc', 'ready', 'local']",
        '      interval: 10s',
        '      timeout: 5s',
        '      retries: 10',
      )
    }
  }
  lines.push('', 'volumes:', ...volumes.map((v) => `  ${v}:`))
  return `${lines.join('\n')}\n`
}

export const composeFile = (ctx: DeployContext) => join(ctx.stateDir, 'infra.compose.yml')

/** Starts (or reconciles) the containers, waits for health, proves the credentials, creates the buckets. */
export async function applyInfra(ctx: DeployContext, plan: InfraPlan): Promise<Finding[]> {
  const infra = ctx.config.infra
  if (infra?.kind !== 'docker' || plan.services.length === 0) return []
  const { host } = ctx
  const { app } = ctx.config
  await host.mkdir(ctx.stateDir, 0o700)
  await host.writeFile(composeFile(ctx), renderCompose(app, infra, plan), 0o600)
  const up = await host.exec('docker', ['compose', '-p', app, '-f', composeFile(ctx), 'up', '-d', '--wait', '--wait-timeout', '180'], { env: plan.secrets })
  if (up.code !== 0) {
    return [{ id: 'infra', level: 'error', message: `docker compose up failed:\n${up.stderr.trim()}`, fix: `docker compose -p ${app} ps; docker logs ${app}-pg` }]
  }
  const findings: Finding[] = []
  for (const service of plan.services) {
    if (service.service === 'postgres') {
      // Over TCP with the password: the local socket would trust anyone and
      // prove nothing about the credentials the app will use.
      const check = await host.exec('docker', ['exec', '-e', 'PGPASSWORD', service.container, 'psql', '-h', '127.0.0.1', '-U', service.user ?? app, '-d', service.database ?? app, '-tAc', 'select 1'],
        { env: { PGPASSWORD: plan.secrets['BASALT_PG_PASSWORD'] ?? '' } })
      if (check.code !== 0 || check.stdout.trim() !== '1') {
        findings.push({
          id: 'C7',
          level: 'error',
          message: `postgres refuses the password in ${ctx.config.env.file ?? '.env'} — the volume ${service.volume} was initialised with another one`,
          fix: 'put the original password back in the .env URL (it is the one the data was created with); never re-create the volume to "fix" this',
        })
      }
    }
    if (service.service === 'redis') {
      const check = await host.exec('docker', ['exec', '-e', 'REDISCLI_AUTH', service.container, 'redis-cli', 'ping'],
        { env: { REDISCLI_AUTH: plan.secrets['BASALT_REDIS_PASSWORD'] ?? '' } })
      if (!check.stdout.includes('PONG')) findings.push({ id: 'C7', level: 'error', message: `redis refuses the password in ${ctx.config.env.file ?? '.env'}` })
    }
  }
  return findings
}

/** The dedicated Postgres as its owner, over TCP — the credentials the `.env` holds. */
export function dockerPostgres(plan: InfraPlan): PostgresHandle | undefined {
  const pg = plan.services.find((s) => s.service === 'postgres')
  if (!pg) return undefined
  return { container: pg.container, user: pg.user ?? '', database: pg.database ?? '', password: plan.secrets['BASALT_PG_PASSWORD'] ?? '', tcp: true, url: plan.ownerUrl }
}

/**
 * After the containers are up (dedicated) or found running (external): the
 * app role and the buckets (RFC 0007 §4.1–4.2). Returns what it did, one line
 * per service; throws on what it could not do — before anything is built.
 */
export async function maintainServices(ctx: DeployContext, plan: InfraPlan, values: Map<string, string>): Promise<string[]> {
  const lines: string[] = []
  const role = appRoleOf(ctx.config)
  const pg = ctx.config.infra?.kind === 'docker' ? dockerPostgres(plan) : externalPostgres(ctx, values)
  if (role) {
    if (!pg) throw new DeployError(`appRole ${role.name}: no Postgres declared to create it in`)
    lines.push(await ensureAppRole(ctx, pg, role, values))
  }
  const infra = ctx.config.infra
  if (infra?.kind === 'docker' && infra.minio?.buckets.length) {
    const minio = plan.services.find((s) => s.service === 'minio')
    if (minio) {
      lines.push(await ensureBuckets(ctx, { container: minio.container, user: plan.secrets['BASALT_MINIO_USER'] ?? '', password: plan.secrets['BASALT_MINIO_PASSWORD'] ?? '' }, infra.minio.buckets))
    }
  }
  const external = externalOf(ctx.config)?.minio
  if (external?.buckets?.length) lines.push(await ensureBuckets(ctx, await minioHandle(ctx, external.container), external.buckets))
  return lines
}

export function describeInfra(plan: InfraPlan): string[] {
  return plan.services.map((s) => {
    const ports = s.consolePort === undefined ? `127.0.0.1:${s.port}` : `127.0.0.1:${s.port} (console ${s.consolePort})`
    const credentials = s.source === 'container' ? 'credentials from the container' : s.source === 'env' ? 'credentials from .env' : 'new credentials'
    return `${s.service}: ${s.action} ${s.container} on ${ports}, ${credentials}`
  })
}
