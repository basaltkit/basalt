/**
 * RFC 0007 §4–§6: Globex's infra.sh and verify.sh as config. A Globex-shaped
 * server — external containers, a compose project, an app role — deployed
 * with no hook at all.
 */
import { describe, expect, it } from 'vitest'
import { compose, external, validateConfig, DeployConfigError, apache, type DeployConfig } from '../src/config.js'
import type { DeployContext } from '../src/context.js'
import { plan, preflight, run } from '../src/pipeline.js'
import { readReleases } from '../src/state.js'
import { FakeHost, fail, ok, type Call } from './fake-host.js'

const DIR = '/srv/globex'
const API_ENV = '/etc/globex/api.env'
const OLD = 'a'.repeat(40)
const NEW = 'b'.repeat(40)
const OWNER = 'postgresql://globex_owner:ownerpw@globex-postgres:5432/globex'
const APP = 'postgresql://globex_app:apppw@globex-postgres:5432/globex'

function globex(extra: Partial<DeployConfig> = {}): DeployConfig {
  return {
    app: 'globex',
    domain: 'globex.example.com',
    tenants: 'subdomain',
    env: { file: API_ENV, fixed: { NODE_ENV: 'production' } },
    infra: external({
      postgres: { container: 'globex-postgres', urlKey: 'GLOBEX_OWNER_DATABASE_URL', appRole: { name: 'globex_app', urlKey: 'GLOBEX_DATABASE_URL' } },
      redis: { container: 'globex-redis' },
      minio: { container: 'minio', buckets: [{ name: 'globex-documents', versioned: true }, { name: 'globex-quarantine', expireDays: 1 }] },
    }),
    migrate: { command: ['pnpm', 'db:deploy'], tenants: true },
    runtime: compose({
      file: 'docker/compose.prod.yml',
      images: [{ tag: 'globex', dockerfile: 'docker/app/Dockerfile', env: 'GLOBEX_IMAGE' }],
      upstream: { service: 'api', port: 3001 },
      attach: { 'globex-postgres': ['data'], 'globex-redis': ['data', 'sandbox'] },
      jobs: [{ service: 'freshclam', command: ['freshclam', '--stdout'], once: { exists: '/var/lib/clamav/main.c?d' } }],
    }),
    verify: { logs: { 'ingest-worker': ['EAI_AGAIN', 'ECONNREFUSED'] }, http: [{ path: '/readyz' }] },
    proxy: apache({ managed: false, vhosts: ['globex-app.conf'] }),
    health: { path: '/readyz', timeoutSeconds: 10 },
    ...extra,
  }
}

const ctxOf = (host: FakeHost, config: DeployConfig = globex()): DeployContext =>
  ({ config, dir: DIR, host, pm: 'pnpm', envPath: API_ENV, stateDir: `${DIR}/.basalt` })

interface World {
  host: FakeHost
  up: () => string | undefined
  roles: Set<string>
  networks: Map<string, Set<string>>
  rules: string[]
  sql: string[]
}

function server(options: {
  stopped?: string
  role?: 'missing' | 'stale' | 'ok'
  networks?: boolean
  seeded?: boolean
  logs?: string
  readyz?: number
  env?: string
} = {}): World {
  let head = OLD
  let upSha: string | undefined = 'aaaaaaa'
  const roles = new Set(options.role === 'missing' ? [] : ['globex_app'])
  const networks = new Map<string, Set<string>>(options.networks === false ? [] : [['globex_data', new Set(['globex-postgres'])], ['globex_sandbox', new Set()]])
  const images = new Set(['globex:aaaaaaa'])
  const volumes = new Set(options.networks === false ? [] : ['globex-clamdb'])
  const rules: string[] = []
  const sql: string[] = []
  const host = new FakeHost().put(API_ENV, options.env ?? `NODE_ENV=production\nGLOBEX_OWNER_DATABASE_URL=${OWNER}\nGLOBEX_DATABASE_URL=${APP}\n`, 0o600)
  host.put(`${DIR}/package.json`, '{}').put(`${DIR}/docker/compose.prod.yml`, 'services: {}\n')
  host.put('/etc/apache2/sites-available/globex-app.conf', 'ProxyPass "/api/" "http://127.0.0.1:3001/"\n')
  host.files.set('/etc/apache2/sites-enabled/globex-app.conf', { kind: 'symlink', target: '../sites-available/globex-app.conf' })
  host.http = (url) => (url.endsWith('/readyz') && url.startsWith('http://') ? { status: options.readyz ?? 200 } : { status: 200 })
  const docker = ({ args, options: o }: Call) => {
    const [verb, ...rest] = args
    if (verb === 'inspect' && rest[0] === '--format') return rest[2] === options.stopped ? ok('false\n') : ok('true\n')
    if (verb === 'inspect' && rest[1] === '--format') return ok(JSON.stringify(['MINIO_ROOT_USER=globex', 'MINIO_ROOT_PASSWORD=miniopw']))
    if (verb === 'exec' && args.includes('psql')) {
      const text = o.stdin ?? ''
      sql.push(text)
      const asApp = args.includes('globex_app')
      if (asApp) return options.role === 'stale' ? fail('password authentication failed', 2) : ok('1\n')
      if (text.startsWith('SELECT 1 FROM pg_roles')) return ok(roles.has('globex_app') ? '1\n' : '')
      if (text.includes('CREATE ROLE')) roles.add('globex_app')
      if (text.includes('DO $basalt$')) return ok('4\n')
      return ok()
    }
    if (verb === 'exec' && args.includes('pg_dump')) return ok('PGDMP')
    if (verb === 'exec' && args.includes('mc')) {
      const mc = args.slice(args.indexOf('mc') + 1)
      if (mc[0] === 'ilm' && mc[2] === 'ls') return ok(rules.includes(mc[4] as string) ? '{"config":{"Rules":[{"Expiration":{"Days":1}}]}}' : '{"config":{"Rules":[]}}')
      if (mc[0] === 'ilm' && mc[2] === 'add') rules.push(mc[5] as string)
      return ok()
    }
    if (verb === 'network' && rest[0] === 'inspect') {
      const members = networks.get(rest[1] as string)
      return members ? ok([...members].map((m) => `${m} `).join('')) : fail('no such network')
    }
    if (verb === 'network' && rest[0] === 'connect') { networks.get(rest[1] as string)?.add(rest[2] as string); return ok() }
    if (verb === 'volume' && rest[0] === 'inspect') return volumes.has(rest[1] as string) ? ok('[]') : fail('no such volume')
    if (verb === 'volume' && rest[0] === 'create') { volumes.add(rest[1] as string); return ok() }
    if (verb === 'image' && rest[0] === 'inspect') return images.has(rest[1] as string) ? ok('[]') : fail('No such image')
    if (verb === 'image' && rest[0] === 'ls') return ok('')
    if (verb === 'build') { images.add(args[args.indexOf('-t') + 1] as string); return ok() }
    if (verb === 'compose') {
      if (args.includes('--services')) return ok('api\nworker\ningest-worker\nfreshclam\n')
      if (args.includes('config') && args.includes('json')) return ok(JSON.stringify({ volumes: { clamdb: { external: true, name: 'globex-clamdb' }, cache: {} } }))
      if (args.includes('config')) return ok()
      if (args.includes('--no-start')) { networks.set('globex_data', new Set()); networks.set('globex_sandbox', new Set()); return ok() }
      if (args.includes('run') && args.includes('--entrypoint')) return options.seeded ? ok('main.cvd\n') : fail('', 2)
      if (args.includes('run')) return ok()
      if (args.includes('logs')) return ok(options.logs ?? 'ingest-worker | ready\n')
      if (args.includes('up')) { upSha = (o.env?.['GLOBEX_IMAGE'] ?? '').split(':')[1]; return ok() }
      if (args.includes('ps')) {
        return ok(upSha ? JSON.stringify({ Service: 'api', State: 'running', Health: 'healthy', Publishers: [{ PublishedPort: 3001 }] }) : '')
      }
    }
    return undefined
  }
  host
    .on((call) => (call.command === 'docker' ? docker(call) : undefined))
    .on(({ command, args }) => {
      if (command !== 'git') return undefined
      const [verb, ...rest] = args
      if (verb === 'status' || verb === 'ls-remote') return ok(verb === 'ls-remote' ? 'x' : '')
      if (verb === 'rev-parse') return ok(rest[0] === '--abbrev-ref' ? 'main\n' : `${head}\n`)
      if (verb === 'merge') { head = NEW; return ok() }
      if (verb === 'reset') { head = rest[1] as string; return ok() }
      return ok()
    })
    .on(({ command }) => (command === 'ss' ? ok('LISTEN 0 4096 127.0.0.1:3001 0.0.0.0:*') : undefined))
    .on(({ command }) => (command === 'node' ? ok('v24.17.0') : undefined))
    .on(({ command }) => (command === 'pnpm' ? ok('10.0.0') : undefined))
    .on(({ command }) => (command === process.execPath ? ok('\n@@basalt-deploy@@{"ok":true,"trueKeys":[]}\n') : undefined))
  return { host, up: () => upSha, roles, networks, rules, sql }
}

const dockerArgs = (host: FakeHost) => host.calls.filter((c) => c.command === 'docker').map((c) => c.args.join(' '))

describe('a Globex deploy with no scripts', () => {
  it('role, buckets, dump in the external container, company grants, attach, job, release, verify', async () => {
    const world = server({ role: 'missing', networks: false })
    const ctx = ctxOf(world.host)
    expect(await run(ctx, { skip: ['tls'] })).toBe(0)
    expect(world.up()).toBe('bbbbbbb')

    // §4.1 — created, with the .env's password, on stdin only.
    expect(world.roles.has('globex_app')).toBe(true)
    const create = world.sql.find((s) => s.includes('CREATE ROLE'))
    expect(create).toContain(`ALTER ROLE "globex_app" WITH LOGIN PASSWORD 'apppw';`)
    expect(create).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE "globex_owner" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "globex_app";')
    expect(create).not.toContain('ON ALL TABLES IN SCHEMA public')
    for (const argv of dockerArgs(world.host)) {
      expect(argv).not.toContain('apppw')
      expect(argv).not.toContain('ownerpw')
      expect(argv).not.toContain('miniopw')
    }
    // §11.3 — company schemas after the migration.
    const grants = world.sql.findIndex((s) => s.includes('DO $basalt$'))
    expect(grants).toBeGreaterThan(-1)
    expect(world.host.transcript).toContain('role globex_app: granted on 4 company schema(s)')

    // §4.2 — buckets, versioning, the expiry rule once.
    expect(dockerArgs(world.host)).toContain('exec -e MC_HOST_local minio mc mb -p local/globex-documents local/globex-quarantine')
    expect(dockerArgs(world.host)).toContain('exec -e MC_HOST_local minio mc version enable local/globex-documents')
    expect(world.rules).toEqual(['local/globex-quarantine'])

    // The dump runs inside the external Postgres, as its owner — no backup.container needed.
    expect(dockerArgs(world.host).some((a) => a.startsWith('exec -e PGPASSWORD globex-postgres pg_dump -U globex_owner -d globex'))).toBe(true)

    // §4.3 — a fresh server: the project created for its networks, then the containers attached.
    expect(dockerArgs(world.host).some((a) => a.includes('up --no-start'))).toBe(true)
    expect(world.networks.get('globex_sandbox')).toEqual(new Set(['globex-redis']))
    expect(world.networks.get('globex_data')).toEqual(new Set(['globex-postgres', 'globex-redis']))

    // A fresh server: the external volume the compose file names, created empty.
    expect(world.host.transcript).toContain('external volume(s) created: globex-clamdb')
    // §4.4 — the job ran (no signatures yet), before up.
    const calls = dockerArgs(world.host)
    const job = calls.findIndex((a) => a.endsWith('run --rm --no-deps freshclam freshclam --stdout'))
    const up = calls.findIndex((a) => a.endsWith('up -d'))
    expect(job).toBeGreaterThan(-1)
    expect(job).toBeLessThan(up)

    // §6
    expect(world.host.transcript).toContain('logs of ingest-worker: clean since the release')
    expect(world.host.transcript).toContain('/readyz: 200')
    expect((await readReleases(ctx))[0]).toMatchObject({ sha: NEW, status: 'ok' })
  })

  it('the second deploy changes nothing: role in place, rule kept, job done, nothing to attach', async () => {
    const world = server({ seeded: true })
    world.rules.push('local/globex-quarantine')
    world.networks.set('globex_data', new Set(['globex-postgres', 'globex-redis']))
    world.networks.set('globex_sandbox', new Set(['globex-redis']))
    expect(await run(ctxOf(world.host), { skip: ['tls'] })).toBe(0)
    expect(world.host.transcript).toContain('role globex_app: in place; grants in place')
    expect(world.sql.some((s) => s.includes('PASSWORD'))).toBe(false)
    expect(world.rules).toEqual(['local/globex-quarantine'])
    expect(world.host.transcript).toContain('globex-quarantine (1-day expiry)')
    expect(world.host.transcript).toContain('job freshclam: already done')
    expect(dockerArgs(world.host).some((a) => a.startsWith('network connect'))).toBe(false)
    expect(dockerArgs(world.host).some((a) => a.includes('--no-start'))).toBe(false)
  })

  it('a role whose password drifted from the .env gets it back', async () => {
    const world = server({ role: 'stale', seeded: true })
    expect(await run(ctxOf(world.host), { skip: ['tls'] })).toBe(0)
    expect(world.host.transcript).toContain('role globex_app: password set from the .env')
  })

  it('an app URL that does not exist yet is generated from the owner\'s, then kept', async () => {
    const world = server({ env: `NODE_ENV=production\nGLOBEX_OWNER_DATABASE_URL=${OWNER}\n`, seeded: true })
    expect(await run(ctxOf(world.host), { skip: ['tls'] })).toBe(0)
    expect(world.host.file(API_ENV)).toMatch(/^GLOBEX_DATABASE_URL=postgresql:\/\/globex_app:[0-9a-f]{48}@globex-postgres:5432\/globex$/m)
  })

  it('a worker that logs EAI_AGAIN is a failed release, rolled back', async () => {
    const world = server({ seeded: true, logs: 'ingest-worker | getaddrinfo EAI_AGAIN globex-redis\n' })
    const ctx = ctxOf(world.host)
    expect(await run(ctx, { skip: ['tls'] })).toBe(1)
    expect(world.up()).toBe('aaaaaaa')
    expect((await readReleases(ctx))[0]).toMatchObject({ status: 'rolled-back', note: expect.stringContaining('ingest-worker logs EAI_AGAIN') })
  })

  it('a verify URL that does not answer is a failed release too', async () => {
    const world = server({ seeded: true, readyz: 503 })
    const config = globex({ health: { path: '/health', timeoutSeconds: 10 } })
    expect(await run(ctxOf(world.host, config), { skip: ['tls'] })).toBe(1)
    expect(world.host.transcript).toContain('/readyz: HTTP 503, expected 200')
  })
})

describe('found before anything is built', () => {
  it('a stopped external container, an unknown service with a suggestion, a missing attach target', async () => {
    const world = server({ stopped: 'globex-redis' })
    const config = globex({
      verify: { logs: { 'ingest': ['EAI_AGAIN'] } },
    })
    const p = await plan(ctxOf(world.host, config), { skip: ['tls'] })
    expect(p).toBe(1)
    expect(world.host.transcript).toContain('redis: globex-redis is not running')
    expect(world.host.transcript).toContain('verify.logs: "ingest" is not a service of docker/compose.prod.yml — did you mean "ingest-worker"?')
    expect(world.host.transcript).toContain('runtime.attach: globex-redis is not running')
    const checked = await preflight(ctxOf(server().host), { skip: ['tls'] })
    expect(checked.findings.filter((f) => f.level === 'error')).toEqual([])
  })

  it('plan says the containers, the role, the bucket policies, attach, the job and verify', async () => {
    const world = server()
    await plan(ctxOf(world.host), { skip: ['tls'] })
    for (const line of [
      'infra: postgres: globex-postgres (external, kept running by its owner)',
      'infra: role globex_app: created if missing, password from GLOBEX_DATABASE_URL, DML grants (company schemas too, after the migration)',
      'infra: buckets: globex-documents (versioned), globex-quarantine (1-day expiry)',
      'backup: pg_dump inside globex-postgres',
      'attach: globex-postgres → data; globex-redis → data, sandbox',
      'job: freshclam freshclam --stdout (unless /var/lib/clamav/main.c?d exists)',
      'verify: no EAI_AGAIN / ECONNREFUSED in the logs of ingest-worker',
      'verify: /readyz answers 200',
    ]) expect(world.host.transcript).toContain(line)
  })

  it('config: bucket names, expiry days, container names and the role name are checked', () => {
    const bad = globex({
      infra: external({
        postgres: { container: 'bad name', appRole: { name: 'Globex-App', urlKey: 'X' } },
        minio: { container: 'minio', buckets: [{ name: 'Bad_Bucket' }, { name: 'ok-bucket', expireDays: 0 }] },
      }),
    })
    try {
      validateConfig(bad)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(DeployConfigError)
      const text = (error as Error).message
      expect(text).toContain('bucket "Bad_Bucket" is not a valid S3 bucket name')
      expect(text).toContain('bucket "ok-bucket": expireDays must be a whole number ≥ 1')
      expect(text).toContain('container "bad name" is not a container name')
      expect(text).toContain('appRole "Globex-App" must be a lowercase Postgres identifier')
    }
  })
})
