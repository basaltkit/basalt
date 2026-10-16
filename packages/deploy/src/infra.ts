import { join } from 'node:path'
import { DEFAULT_S3_KEYS, type DockerInfra } from './config.js'
import { DeployError, type DeployContext, type Finding } from './context.js'
import type { EnvChange } from './dotenv.js'
import { freePort } from './ports.js'
import { ensureBuckets, s3Findings, type S3Target } from './s3.js'
import { appRoleEnv, appRoleOf, ensureAppRole, externalFindings, externalOf, externalPostgres, type PostgresHandle } from './services.js'

/**
 * Dedicated containers, adopted or created (RFC 0006 §6.3).
 *
 * The running container is the truth: its credentials are read back and the
 * `.env` follows them, never the other way round. A fresh password written over
 * an initialised volume is exactly the `P1000` that cost a production deploy
 * (incident 7) — Postgres keeps the first credentials in the data. (SeaweedFS
 * does not: its S3 credentials come from the container's environment, so a
 * new pair on an old volume is a rotation, not a lock-out — RFC 0010 §2.)
 *
 * Passwords never reach a command line (visible in `ps`) or the generated
 * compose file: compose reads them from its own environment, and `docker exec
 * -e NAME` (no value) copies them from the CLI's environment.
 */

export type ServiceName = 'postgres' | 'redis' | 'seaweedfs'

export interface ServicePlan {
  service: ServiceName
  container: string
  volume: string
  action: 'adopt' | 'create'
  port: number
  user?: string
  database?: string
  /** Where the password came from — printed; the password itself never is. */
  source: 'container' | 'env' | 'generated'
}

export interface InfraPlan {
  services: ServicePlan[]
  env: EnvChange[]
  findings: Finding[]
  /** Values compose interpolates (`${BASALT_PG_PASSWORD}`); passed in its environment only. Never printed. */
  secrets: Record<string, string>
  /** The dedicated Postgres's owner URL, as the `.env` will hold it (the app role's is derived from it). */
  ownerUrl?: string
  /**
   * With `access: 'containers'`: each container address in the `.env` and the
   * 127.0.0.1 one that reaches it from the host — for the migrations, which
   * run on the host. `['@myapp-pg:5432', '@127.0.0.1:5433']`.
   */
  hostUrls?: Array<[string, string]>
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

function urlParts(value: string | undefined, container?: string): { user: string; password: string; port: number | undefined; database: string } | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    const onHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    if (!onHost && url.hostname !== container) return undefined
    return {
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      // A container's port is its internal one: no use for picking the published port.
      port: onHost ? Number(url.port) : undefined,
      database: url.pathname.replace(/^\//, ''),
    }
  } catch {
    return undefined
  }
}

const names = (app: string, project: string, service: ServiceName, container?: string) => {
  const suffix = service === 'postgres' ? 'pg' : service
  // Compose prefixes volumes with the project name — by default the app — so
  // this is what an older compose file with the same project name created.
  return { container: container ?? `${app}-${suffix}`, volumeKey: `${app}-${suffix}-data`, volume: `${project}_${app}-${suffix}-data` }
}

/** The compose project of the dedicated infra. */
export const infraProject = (app: string, infra: DockerInfra) => infra.project ?? app

export async function planInfra(ctx: DeployContext, values: Map<string, string>): Promise<InfraPlan> {
  const infra = ctx.config.infra
  const plan: InfraPlan = { services: [], env: [], findings: [], secrets: {}, hostUrls: [] }
  if (infra?.kind === 'external') {
    plan.findings.push(...await externalFindings(ctx))
    if (infra.s3) {
      const target = externalS3Target(ctx, values)
      plan.findings.push(...('error' in target ? [{ id: 'infra', level: 'error' as const, message: target.error }] : await s3Findings(ctx, target)))
    }
    const pg = infra.postgres
    if (pg) plan.env.push(...appRoleEnv(ctx, values, values.get(pg.urlKey ?? 'DATABASE_URL')))
    return plan
  }
  if (infra?.kind !== 'docker') return plan
  const { app } = ctx.config
  const project = infraProject(app, infra)
  const inContainers = infra.access === 'containers'
  /** The address the `.env` holds: the container's, or the host's. */
  const address = (container: string, internal: number, published: number) => {
    if (!inContainers) return `127.0.0.1:${published}`
    plan.hostUrls?.push([`${container}:${internal}`, `127.0.0.1:${published}`])
    return `${container}:${internal}`
  }
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
    const { container, volume } = names(app, project, 'postgres', pg.container)
    const running = await inspect(ctx, container)
    const fromEnv = urlParts(values.get(pg.urlKey), inContainers ? container : undefined)
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
    plan.ownerUrl = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${address(container, 5432, port)}/${database}${params ? `?${params}` : ''}`
    setEnv(pg.urlKey, plan.ownerUrl,
      source === 'container' ? `from the running ${container}` : source === 'generated' ? 'new database' : 'port or parameters')
    plan.env.push(...appRoleEnv(ctx, values, plan.ownerUrl))
    plan.secrets['BASALT_PG_PASSWORD'] = password
    plan.services.push({ service: 'postgres', container, volume, action: running ? 'adopt' : 'create', port, user, database, source })
  }

  if (infra.redis) {
    const redis = infra.redis
    const { container, volume } = names(app, project, 'redis', redis.container)
    const running = await inspect(ctx, container)
    const fromEnv = urlParts(values.get(redis.urlKey), inContainers ? container : undefined)
    let password = running?.env.get('REDIS_PASSWORD')
    let source: ServicePlan['source'] = 'container'
    if (password === undefined && fromEnv?.password) { password = fromEnv.password; source = 'env' }
    // Redis keeps no credentials in its data: a new password is always safe.
    if (password === undefined) { password = ctx.host.randomHex(24); source = 'generated' }
    const port = await pick(redis.port, running?.ports.get('6379/tcp') ?? fromEnv?.port, 6380)
    setEnv(redis.urlKey, `redis://:${encodeURIComponent(password)}@${address(container, 6379, port)}`,
      source === 'container' ? `from the running ${container}` : source === 'generated' ? 'new redis' : 'port')
    plan.secrets['BASALT_REDIS_PASSWORD'] = password
    plan.services.push({ service: 'redis', container, volume, action: running ? 'adopt' : 'create', port, source })
  }

  if (infra.seaweedfs) {
    const sw = infra.seaweedfs
    const { container, volume } = names(app, project, 'seaweedfs', sw.container)
    const running = await inspect(ctx, container)
    let accessKey = running?.env.get('AWS_ACCESS_KEY_ID')
    let secretKey = running?.env.get('AWS_SECRET_ACCESS_KEY')
    let source: ServicePlan['source'] = 'container'
    if ((!accessKey || !secretKey) && values.get(sw.keys.secretKey)) {
      accessKey = values.get(sw.keys.accessKey) || sw.accessKey
      secretKey = values.get(sw.keys.secretKey) as string
      source = 'env'
    }
    // Not kept in the data (unlike Postgres): an old volume opens with new
    // credentials, and the objects stay readable — verified, RFC 0010 §2.
    if (!accessKey || !secretKey) { accessKey = sw.accessKey; secretKey = ctx.host.randomHex(24); source = 'generated' }
    let endpointPort: number | undefined
    try {
      const endpoint = values.get(sw.keys.endpoint)
      endpointPort = endpoint && !inContainers ? Number(new URL(endpoint).port) || undefined : undefined
    } catch {
      endpointPort = undefined
    }
    const port = await pick(sw.port, running?.ports.get('8333/tcp') ?? endpointPort, 8333)
    const reason = source === 'container' ? `from the running ${container}` : source === 'generated' ? 'new storage' : 'port'
    setEnv(sw.keys.endpoint, `http://${address(container, 8333, port)}`, reason)
    setEnv(sw.keys.accessKey, accessKey, reason)
    setEnv(sw.keys.secretKey, secretKey, reason)
    plan.secrets['BASALT_S3_ACCESS_KEY'] = accessKey
    plan.secrets['BASALT_S3_SECRET_KEY'] = secretKey
    // Closes SeaweedFS's admin gRPC (identities, policies) to anything but a
    // signed caller: 4.48 accepted them unauthenticated from any neighbour on
    // the network — an `attach`ed sandbox could have made itself an admin.
    plan.secrets['BASALT_S3_SIGNING_KEY'] = running?.env.get('WEED_JWT_FILER_SIGNING_KEY') || ctx.host.randomHex(32)
    plan.services.push({ service: 'seaweedfs', container, volume, action: running ? 'adopt' : 'create', port, source })
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
    `name: ${infraProject(app, infra)}`,
    '',
    'services:',
  ]
  const volumes: string[] = []
  for (const service of plan.services) {
    const key = service.volume.slice(infraProject(app, infra).length + 1)
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
    if (service.service === 'seaweedfs' && infra.seaweedfs) {
      lines.push(
        '  seaweedfs:',
        `    image: ${infra.seaweedfs.image}`,
        `    container_name: ${service.container}`,
        '    restart: unless-stopped',
        `    labels: { basalt.app: ${app} }`,
        // One process runs master, volume, filer and S3. Only the S3 API listens
        // beyond the container's loopback: the others have no authentication,
        // and `runtime.attach` puts this container on the app's networks.
        // Iceberg and Lance are extra listeners nothing here uses.
        "    command: ['server', '-dir=/data', '-s3', '-s3.port=8333', '-ip=127.0.0.1', '-ip.bind=127.0.0.1', '-s3.ip.bind=0.0.0.0', '-s3.port.iceberg=0', '-s3.port.lance=0']",
        `    ports: ['127.0.0.1:${service.port}:8333']`,
        '    environment:',
        '      AWS_ACCESS_KEY_ID: ${BASALT_S3_ACCESS_KEY:?missing}',
        '      AWS_SECRET_ACCESS_KEY: ${BASALT_S3_SECRET_KEY:?missing}',
        '      WEED_JWT_FILER_SIGNING_KEY: ${BASALT_S3_SIGNING_KEY:?missing}',
        `    volumes: ['${key}:/data']`,
        '    healthcheck:',
        // `/healthz` answers before the volume server has joined: reads fail
        // for a few seconds more. Healthy = a data node registered too.
        `      test: ['CMD-SHELL', 'wget -q -O /dev/null http://127.0.0.1:8333/healthz && wget -q -O- http://127.0.0.1:9333/dir/status | grep -q Url']`,
        '      interval: 10s',
        '      timeout: 5s',
        '      retries: 12',
        '      start_period: 30s',
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
  const project = infraProject(app, infra)
  const up = await host.exec('docker', ['compose', '-p', project, '-f', composeFile(ctx), 'up', '-d', '--wait', '--wait-timeout', '180'], { env: plan.secrets })
  if (up.code !== 0) {
    return [{ id: 'infra', level: 'error', message: `docker compose up failed:\n${up.stderr.trim()}`, fix: `docker compose -p ${project} ps; docker logs ${plan.services[0]?.container ?? app}` }]
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
    if (service.service === 'seaweedfs') {
      const target = seaweedfsTarget(plan)
      if (target) findings.push(...(await s3Findings(ctx, target)).map((f) => ({ ...f, id: 'C7' })))
    }
  }
  return findings
}

/** The dedicated store, from the host: its published port, the credentials the `.env` holds. */
function seaweedfsTarget(plan: InfraPlan): S3Target | undefined {
  const sw = plan.services.find((s) => s.service === 'seaweedfs')
  if (!sw) return undefined
  return { label: 'seaweedfs', endpoint: `http://127.0.0.1:${sw.port}`, accessKey: plan.secrets['BASALT_S3_ACCESS_KEY'] ?? '', secretKey: plan.secrets['BASALT_S3_SECRET_KEY'] ?? '' }
}

/** An external store, from the `.env` (and `hostEndpoint` when the `.env` names a container). */
export function externalS3Target(ctx: DeployContext, values: Map<string, string>): S3Target | { error: string } {
  const s3 = externalOf(ctx.config)?.s3
  const keys = s3?.keys ?? DEFAULT_S3_KEYS
  const endpoint = s3?.hostEndpoint ?? values.get(keys.endpoint)
  const accessKey = values.get(keys.accessKey)
  const secretKey = values.get(keys.secretKey)
  const missing = [[keys.endpoint, endpoint], [keys.accessKey, accessKey], [keys.secretKey, secretKey]].filter(([, v]) => !v).map(([k]) => k)
  if (missing.length || !endpoint || !accessKey || !secretKey) return { error: `s3: ${missing.join(', ')} missing in ${ctx.config.env.file ?? '.env'}` }
  return { label: 's3', endpoint, accessKey, secretKey }
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
  const dedicated = seaweedfsTarget(plan)
  if (infra?.kind === 'docker' && dedicated && infra.seaweedfs?.buckets.length) lines.push(await ensureBuckets(ctx, dedicated, infra.seaweedfs.buckets))
  const external = externalOf(ctx.config)?.s3
  if (external?.buckets?.length) {
    const target = externalS3Target(ctx, values)
    if ('error' in target) throw new DeployError(target.error)
    lines.push(await ensureBuckets(ctx, target, external.buckets))
  }
  return lines
}

export function describeInfra(plan: InfraPlan): string[] {
  return plan.services.map((s) => {
    const ports = `127.0.0.1:${s.port}`
    const credentials = s.source === 'container' ? 'credentials from the container' : s.source === 'env' ? 'credentials from .env' : 'new credentials'
    return `${s.service}: ${s.action} ${s.container} on ${ports}, ${credentials}`
  })
}
