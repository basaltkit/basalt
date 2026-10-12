/**
 * Phase 2 (RFC 0006 §13): the compose runtime, hooks, unmanaged Apache, an
 * env file outside the checkout with a mirror, migrations by command — on a
 * server shaped like Mukanda's.
 */
import { describe, expect, it } from 'vitest'
import { apachePreflight, proxiedPorts } from '../src/apache.js'
import { composeBuild, composeEnv, composeHealthy, composePreflight, composeRelease, pruneImages } from '../src/compose.js'
import { apache, compose, DeployConfigError, validateConfig, type DeployConfig } from '../src/config.js'
import type { DeployContext } from '../src/context.js'
import { install, plan, preflight, run } from '../src/pipeline.js'
import { readReleases } from '../src/state.js'
import { FakeHost, fail, ok } from './fake-host.js'

const DIR = '/srv/mukanda'
const API_ENV = '/etc/mukanda/api.env'
const WORKER_ENV = '/etc/mukanda/worker.env'
const OLD = 'a'.repeat(40)
const NEW = 'b'.repeat(40)
const ENV = [
  'NODE_ENV=production',
  'MUKANDA_PORT=3000',
  'MUKANDA_OWNER_DATABASE_URL=postgresql://mukanda_owner:ownerpw@mukanda-postgres:5432/mukanda',
  'MUKANDA_DATABASE_URL=postgresql://mukanda_app:apppw@mukanda-postgres:5432/mukanda',
  'MUKANDA_APP_SECRET=s3cr3t',
].join('\n') + '\n'

function mukanda(extra: Partial<DeployConfig> = {}): DeployConfig {
  return {
    app: 'mukanda',
    domain: 'mukanda.aipro.ao',
    tenants: 'subdomain',
    branch: 'main',
    env: { file: API_ENV, mirror: [WORKER_ENV], fixed: { NODE_ENV: 'production' } },
    infra: { kind: 'external' },
    build: { web: 'web' },
    migrate: {
      command: ['./node_modules/.bin/tsx', 'scripts/db.ts', 'deploy'],
      env: (v) => ({
        MUKANDA_OWNER_DATABASE_URL: (v.get('MUKANDA_OWNER_DATABASE_URL') ?? '').replace('@mukanda-postgres:', '@127.0.0.1:'),
        MUKANDA_DATABASE_URL: (v.get('MUKANDA_DATABASE_URL') ?? '').replace('@mukanda-postgres:', '@127.0.0.1:'),
      }),
    },
    backup: { urlKey: 'MUKANDA_OWNER_DATABASE_URL' },
    hooks: { infra: [['bash', 'scripts/deploy/infra.sh']], verify: [['bash', 'scripts/deploy/verify.sh']] },
    runtime: compose({
      file: 'docker/compose.prod.yml',
      images: [
        { tag: 'mukanda', dockerfile: 'docker/app/Dockerfile', env: 'MUKANDA_IMAGE' },
        { tag: 'mukanda-ingest', dockerfile: 'docker/ingest/Dockerfile', env: 'MUKANDA_INGEST_IMAGE' },
        { tag: 'mukanda-clamd', dockerfile: 'docker/clamav/Dockerfile', context: 'docker/clamav', env: 'MUKANDA_CLAMD_IMAGE' },
      ],
      upstream: { service: 'api', port: 3001 },
      env: { MUKANDA_API_HOST_PORT: '3001' },
      keepImages: 2,
    }),
    proxy: apache({ managed: false, vhosts: ['mukanda-app.conf', 'mukanda-share.conf'] }),
    health: { path: '/readyz', timeoutSeconds: 30 },
    ...extra,
  }
}

const ctxOf = (host: FakeHost, config: DeployConfig = mukanda()): DeployContext =>
  ({ config, dir: DIR, host, pm: 'pnpm', envPath: API_ENV, stateDir: `${DIR}/.basalt` })

const VHOST = 'ProxyPass        "/api/" "http://127.0.0.1:3001/" flushpackets=on\nProxyPassReverse "/api/" "http://127.0.0.1:3001/"\n'

interface Server {
  host: FakeHost
  head: () => string
  images: Set<string>
  up: () => string | undefined
}

/** A Mukanda-shaped server: images by tag, one compose project, git with two commits. */
function server(options: {
  healthyAt?: (sha: string) => boolean
  restarting?: string
  verifyFails?: (sha: string) => boolean
  infraFails?: boolean
  images?: string[]
} = {}): Server {
  let head = OLD
  let upSha: string | undefined = 'aaaaaaa'  // what compose runs: the 7-char image tag
  const images = new Set(options.images ?? ['mukanda:aaaaaaa', 'mukanda-ingest:aaaaaaa', 'mukanda-clamd:aaaaaaa'])
  const host = new FakeHost().put(API_ENV, ENV, 0o600).put(WORKER_ENV, ENV, 0o600)
  host.put(`${DIR}/package.json`, '{}').put(`${DIR}/docker/compose.prod.yml`, 'services: {}\n')
  for (const v of ['mukanda-app.conf', 'mukanda-share.conf']) {
    host.put(`/etc/apache2/sites-available/${v}`, VHOST)
    host.files.set(`/etc/apache2/sites-enabled/${v}`, { kind: 'symlink', target: `../sites-available/${v}` })
  }
  host.certificates.set('*', { names: ['mukanda.aipro.ao', '*.mukanda.aipro.ao'], validTo: new Date('2027-01-01'), trusted: true })
  host.http = (url) => (url.startsWith('https://') ? { status: 200 } : (options.healthyAt ?? (() => true))(upSha ?? '') ? { status: 200 } : { error: 'ECONNREFUSED' })
  host
    .on(({ command, args }) => {
      if (command !== 'git') return undefined
      const [verb, ...rest] = args
      if (verb === 'status' || verb === 'ls-remote') return ok(verb === 'ls-remote' ? 'x' : '')
      if (verb === 'rev-parse') return ok(rest[0] === '--abbrev-ref' ? 'main\n' : `${head}\n`)
      if (verb === 'merge') { head = NEW; return ok() }
      if (verb === 'reset') { head = rest[1] as string; return ok() }
      return ok()
    })
    .on(({ command, args, options: o }) => {
      if (command !== 'docker') return undefined
      if (args[0] === 'image' && args[1] === 'inspect') return images.has(args[2] as string) ? ok('[]') : fail('No such image')
      if (args[0] === 'image' && args[1] === 'ls') return ok([...images].filter((i) => i.startsWith(`${args[2]}:`)).map((i) => i.split(':')[1]).join('\n'))
      if (args[0] === 'image' && args[1] === 'rm') { images.delete(args[2] as string); return ok() }
      if (args[0] === 'build') { images.add(args[args.indexOf('-t') + 1] as string); return ok() }
      if (args[0] === 'compose') {
        if (args.includes('config')) return ok()
        if (args.includes('up')) { upSha = (o.env?.['MUKANDA_IMAGE'] ?? '').split(':')[1]; return ok() }
        if (args.includes('ps')) {
          if (!upSha) return ok('')
          const rows = [
            { Service: 'api', State: 'running', Health: (options.healthyAt ?? (() => true))(upSha) ? 'healthy' : 'unhealthy', Publishers: [{ PublishedPort: 3001 }] },
            { Service: 'worker', State: 'running', Health: '', Publishers: [] },
            { Service: 'ingest-worker', State: options.restarting === upSha ? 'restarting' : 'running', Health: '', Publishers: [] },
          ]
          return ok(rows.map((r) => JSON.stringify(r)).join('\n'))
        }
      }
      return undefined
    })
    .on(({ command, args }) => {
      if (command !== 'bash') return undefined
      if (args[0] === 'scripts/deploy/infra.sh') return options.infraFails ? fail('roles', 1) : ok()
      if (args[0] === 'scripts/deploy/verify.sh') return (options.verifyFails ?? (() => false))(upSha ?? '') ? fail('ingest-worker: EAI_AGAIN', 1) : ok()
      return undefined
    })
    .on(({ command }) => (command === 'ss' ? ok('LISTEN 0 4096 127.0.0.1:3001 0.0.0.0:*') : undefined))
    .on(({ command }) => (command === 'node' ? ok('v24.17.0') : undefined))
    .on(({ command }) => (command === 'pnpm' ? ok('10.0.0') : undefined))
    .on(({ command }) => (command === './node_modules/.bin/tsx' ? ok() : undefined))
    .on(({ command }) => (command === 'pg_dump' ? ok('PGDMP') : undefined))
    .on(({ command }) => (command === process.execPath ? ok('\n@@basalt-deploy@@{"ok":true,"trueKeys":[]}\n') : undefined))
  return { host, head: () => head, images, up: () => upSha }
}

describe('config', () => {
  it('C4: image tags the app does not own are refused (retention would prune them)', () => {
    const bad = mukanda()
    if (bad.runtime.kind === 'compose') bad.runtime.images[0] = { tag: 'postgres', dockerfile: 'x', env: 'X_IMAGE' }
    expect(() => validateConfig(bad)).toThrow(/"postgres" must be "mukanda" or start with "mukanda-"/)
  })

  it('unmanaged Apache needs the vhosts it checks; hooks are commands', () => {
    expect(() => validateConfig(mukanda({ proxy: apache({ managed: false }) }))).toThrow(DeployConfigError)
    expect(() => validateConfig(mukanda({ hooks: { infra: [[]] } }))).toThrow(/non-empty array of strings/)
    expect(() => validateConfig(mukanda())).not.toThrow()
  })
})

describe('the compose runtime', () => {
  it('compose sees each image as <tag>:<7-char sha>, plus runtime.env', () => {
    expect(composeEnv(ctxOf(new FakeHost()), NEW)).toEqual({
      MUKANDA_API_HOST_PORT: '3001',
      MUKANDA_IMAGE: 'mukanda:bbbbbbb',
      MUKANDA_INGEST_IMAGE: 'mukanda-ingest:bbbbbbb',
      MUKANDA_CLAMD_IMAGE: 'mukanda-clamd:bbbbbbb',
    })
  })

  it('builds only what is missing for the commit', async () => {
    const { host, images } = server({ images: ['mukanda:bbbbbbb'] })
    await composeBuild(ctxOf(host), NEW)
    expect(host.commands('docker').filter((c) => c.includes(' build '))).toEqual([
      `docker build -f ${DIR}/docker/ingest/Dockerfile -t mukanda-ingest:bbbbbbb ${DIR}`,
      `docker build -f ${DIR}/docker/clamav/Dockerfile -t mukanda-clamd:bbbbbbb ${DIR}/docker/clamav`,
    ])
    expect(images.has('mukanda-clamd:bbbbbbb')).toBe(true)
  })

  it('never starts a commit whose images are missing', async () => {
    const { host } = server({ images: [] })
    await expect(composeRelease(ctxOf(host), NEW)).rejects.toThrow('the image mukanda:bbbbbbb does not exist')
  })

  it('health: the upstream healthy, and nothing restarting (the ingest worker once crash-looped unnoticed)', async () => {
    const restarting = server({ restarting: 'aaaaaaa' })
    expect(await composeHealthy(ctxOf(restarting.host), OLD)).toEqual({ ok: false, why: 'restarting: ingest-worker' })
    const sick = server({ healthyAt: () => false })
    expect(await composeHealthy(ctxOf(sick.host), OLD)).toEqual({ ok: false, why: 'api: unhealthy after 30s' })
    expect(await composeHealthy(ctxOf(server().host), OLD)).toEqual({ ok: true })
  })

  it('C1: docker-proxy holds the port — ours when our upstream service publishes it, foreign otherwise', async () => {
    const { host } = server()
    expect((await composePreflight(ctxOf(host), OLD)).filter((f) => f.id === 'C1')).toEqual([])
    const other = mukanda()
    if (other.runtime.kind === 'compose') other.runtime.upstream = { service: 'api', port: 3001 }
    const foreign = server()
    foreign.host.handlers.unshift(({ command, args }) => (command === 'docker' && args.includes('ps') ? ok('') : undefined))
    expect((await composePreflight(ctxOf(foreign.host, other), OLD)).find((f) => f.id === 'C1')?.level).toBe('error')
  })

  it('retention removes only old <sha> tags of the configured images', async () => {
    const { host, images } = server({ images: ['mukanda:aaaaaaa', 'mukanda:1111111', 'mukanda:latest', 'mukanda-ingest:1111111', 'mukanda-clamd:aaaaaaa'] })
    const removed = await pruneImages(ctxOf(host), [OLD])
    expect(removed.sort()).toEqual(['mukanda-ingest:1111111', 'mukanda:1111111'])
    expect([...images].sort()).toEqual(['mukanda-clamd:aaaaaaa', 'mukanda:aaaaaaa', 'mukanda:latest'])
  })
})

describe('a Mukanda deploy', () => {
  it('runs every step: hooks, images, migration by command with host URLs, compose up, verify, retention', async () => {
    const { host, head, images, up } = server()
    const ctx = ctxOf(host)
    expect(await run(ctx, { skip: ['tls'] })).toBe(0)
    expect(head()).toBe(NEW)
    expect(up()).toBe('bbbbbbb')
    expect(host.printed.filter((l) => l.startsWith('STEP')).map((l) => l.slice(5))).toEqual(
      ['preflight', 'fetch', 'env', 'infra', 'build', 'validate', 'backup', 'migrate', 'release', 'health', 'verify', 'record'],
    )
    const migrate = host.calls.find((c) => c.command === './node_modules/.bin/tsx')
    expect(migrate?.args).toEqual(['scripts/db.ts', 'deploy'])
    expect(migrate?.options.env).toMatchObject({ MUKANDA_OWNER_DATABASE_URL: 'postgresql://mukanda_owner:ownerpw@127.0.0.1:5432/mukanda' })
    // The dump reaches the database the same way, without the password on its command line.
    const dump = host.calls.find((c) => c.command === 'pg_dump')
    expect(dump?.args[1]).toBe('postgresql://mukanda_owner@127.0.0.1:5432/mukanda')
    // No prisma migrate deploy unasked for an app with its own command.
    expect(host.commands('pnpm').some((c) => c.includes('migrate'))).toBe(false)
    const hooks = host.calls.filter((c) => c.command === 'bash')
    expect(hooks.map((c) => c.args[0])).toEqual(['scripts/deploy/infra.sh', 'scripts/deploy/verify.sh'])
    expect(hooks[1]?.options.env).toMatchObject({ DEPLOY_SHA: NEW, DEPLOY_APP: 'mukanda', MUKANDA_IMAGE: 'mukanda:bbbbbbb' })
    // Under compose the .env gets no PORT: the container's port is the compose file's.
    expect(host.file(API_ENV)).not.toMatch(/^PORT=/m)
    expect(host.file(WORKER_ENV)).toBe(host.file(API_ENV))
    expect(images.has('mukanda:bbbbbbb')).toBe(true)
    expect((await readReleases(ctx))[0]).toMatchObject({ sha: NEW, status: 'ok' })
  })

  it('a failed verify hook is a failed release: back to the previous images, no rebuild', async () => {
    const { host, head, up } = server({ verifyFails: (sha) => sha === 'bbbbbbb' })
    const ctx = ctxOf(host)
    expect(await run(ctx, { skip: ['tls'] })).toBe(1)
    expect(head()).toBe(OLD)
    expect(up()).toBe('aaaaaaa')
    expect(host.commands('docker').filter((c) => c.includes(' build ') && c.includes(':aaaaaaa'))).toEqual([])
    expect((await readReleases(ctx))[0]).toMatchObject({ status: 'rolled-back', note: expect.stringContaining('verify hook') })
  })

  it('an unhealthy upstream is rolled back too', async () => {
    const { host, up } = server({ healthyAt: (sha) => sha !== 'bbbbbbb' })
    expect(await run(ctxOf(host), { skip: ['tls'] })).toBe(1)
    expect(up()).toBe('aaaaaaa')
    expect(host.transcript).toContain('api: unhealthy')
  })

  it('a failed infra hook stops before anything is built, and puts the code back', async () => {
    const { host, head } = server({ infraFails: true })
    await expect(run(ctxOf(host), { skip: ['tls'] })).rejects.toThrow(/infra hook `bash scripts\/deploy\/infra.sh` failed/)
    expect(head()).toBe(OLD)
    expect(host.commands('docker').some((c) => c.includes(' build '))).toBe(false)
  })

  it('plan says the images, the hooks, the migration command and the release', async () => {
    const { host } = server()
    await plan(ctxOf(host), { skip: ['tls'] })
    for (const line of [
      'docker build mukanda, mukanda-ingest, mukanda-clamd',
      'infra hook: bash scripts/deploy/infra.sh',
      'migrate: ./node_modules/.bin/tsx scripts/db.ts deploy',
      'release: docker compose -p mukanda up -d',
      'verify hook: bash scripts/deploy/verify.sh',
    ]) expect(host.transcript).toContain(line)
  })
})

describe('the env file outside the checkout', () => {
  it('C10: a mirror that differs is an error, before anything runs', async () => {
    const { host } = server()
    host.put(WORKER_ENV, `${ENV}MUKANDA_EXTRA=1\n`, 0o600)
    const { findings } = await preflight(ctxOf(host), { skip: ['tls'] })
    expect(findings.find((f) => f.id === 'C10')?.message).toBe(`${WORKER_ENV} (env.mirror) differs from ${API_ENV}`)
  })

  it('install takes over the files and the app\'s own directory, never /etc, and leaves unmanaged Apache alone', async () => {
    const { host } = server()
    host.userId = 0
    host.on(({ command }) => (['chown', 'chmod', 'id'].includes(command) ? ok('ubuntu') : undefined))
    await install(ctxOf(host), 'ubuntu')
    expect(host.commands('chown')).toEqual(expect.arrayContaining([
      `chown ubuntu: ${API_ENV}`, `chown ubuntu: ${WORKER_ENV}`, 'chown ubuntu: /etc/mukanda',
    ]))
    expect(host.commands('chown')).not.toContain('chown ubuntu: /etc')
    expect(host.commands('apachectl')).toEqual([])
    expect(host.transcript).toContain('/etc/mukanda and its env files (api.env, worker.env) now owned by ubuntu')
  })

  it('a shared directory is not taken over; the operator is told', async () => {
    const { host } = server()
    host.userId = 0
    host.put('/etc/shared.env', ENV, 0o600)
    host.on(({ command }) => (['chown', 'chmod', 'id'].includes(command) ? ok() : undefined))
    await install(ctxOf(host, mukanda({ env: { file: '/etc/shared.env' } })), 'ubuntu')
    expect(host.commands('chown')).not.toContain('chown ubuntu: /etc')
    expect(host.transcript).toContain("/etc is not mukanda's own directory")
  })
})

describe('Apache, checked but not owned', () => {
  it('reads the quoted ProxyPass form Mukanda writes', () => {
    expect(proxiedPorts(VHOST)).toEqual([3001])
  })

  it('C2 on a copy, C1 on the wrong port, silent when both are right', async () => {
    const { host } = server()
    const ctx = ctxOf(host)
    expect(await apachePreflight(ctx, 3001)).toEqual([])
    host.put('/etc/apache2/sites-enabled/mukanda-app.conf', VHOST.replaceAll('3001', '3000'))
    const findings = await apachePreflight(ctx, 3001)
    expect(findings.map((f) => f.id).sort()).toEqual(['C1', 'C2'])
    expect(findings.find((f) => f.id === 'C2')?.message).toMatch(/DIFFERS/)
  })
})

describe('backup inside a container (0.2.1)', () => {
  const withPostgres = (state: 'running' | 'stopped' | 'missing' = 'running') => {
    const s = server()
    s.host.on(({ command, args }) => {
      if (command !== 'docker') return undefined
      if (args[0] === 'inspect') return state === 'missing' ? fail('No such object') : ok(state === 'running' ? 'true\n' : 'false\n')
      if (args[0] === 'exec' && args.includes('pg_dump')) return ok('PGDMP')
      return undefined
    })
    return s
  }
  const config = (extra: Partial<DeployConfig['backup']> = {}) =>
    mukanda({ backup: { urlKey: 'MUKANDA_OWNER_DATABASE_URL', container: 'mukanda-postgres', beforeMigrate: true, ...extra } })

  it('dumps with docker exec, the password in the environment only, before the migration', async () => {
    const { host } = withPostgres()
    const ctx = ctxOf(host, config())
    expect(await run(ctx, { skip: ['tls'] })).toBe(0)
    const dump = host.calls.find((c) => c.command === 'docker' && c.args[0] === 'exec')
    expect(dump?.args).toEqual(['exec', '-e', 'PGPASSWORD', 'mukanda-postgres', 'pg_dump', '-U', 'mukanda_owner', '-d', 'mukanda', '--format=custom', '--no-owner', '--no-acl'])
    expect(dump?.options.env).toEqual({ PGPASSWORD: 'ownerpw' })
    expect(host.calls.some((c) => c.command === 'pg_dump')).toBe(false)
    expect(host.calls.indexOf(dump!)).toBeLessThan(host.calls.findIndex((c) => c.command === './node_modules/.bin/tsx'))
    const record = (await readReleases(ctx))[0]
    expect(record?.backup).toMatch(/^\/srv\/mukanda\/backups\/predeploy\/.+-bbbbbbb\.dump$/)
    expect(host.mode(record!.backup!)).toBe(0o600)
  })

  it('the restore line names the container, the user and the database', async () => {
    const { restoreCommand } = await import('../src/backup.js')
    const values = new Map([['MUKANDA_OWNER_DATABASE_URL', 'postgresql://mukanda_owner:pw@mukanda-postgres:5432/mukanda?schema=public']])
    expect(restoreCommand(ctxOf(new FakeHost(), config()), { services: [], env: [], findings: [], secrets: {} }, '/b.dump', values))
      .toBe('docker exec -i mukanda-postgres pg_restore --clean --if-exists --no-owner -U mukanda_owner -d mukanda < /b.dump')
  })

  it('a stopped or missing container is found in the preflight, not after the build', async () => {
    for (const state of ['stopped', 'missing'] as const) {
      const { host } = withPostgres(state)
      const checked = await preflight(ctxOf(host, config()), { skip: ['tls'] })
      expect(checked.findings.find((f) => f.id === 'backup')?.message).toMatch(state === 'stopped' ? /is not running/ : /does not exist/)
    }
    // --skip=backup, or the backup off: not looked at.
    const { host } = withPostgres('missing')
    expect((await preflight(ctxOf(host, config()), { skip: ['tls', 'backup'] })).findings.some((f) => f.id === 'backup')).toBe(false)
    expect((await preflight(ctxOf(host, config({ beforeMigrate: false })), { skip: ['tls'] })).findings.some((f) => f.id === 'backup')).toBe(false)
  })

  it('plan says where the dump runs; a bad container name is refused', async () => {
    const { host } = withPostgres()
    await plan(ctxOf(host, config()), { skip: ['tls'] })
    expect(host.transcript).toContain('backup: pg_dump inside mukanda-postgres → backups/predeploy (keep 10)')
    expect(() => validateConfig(config({ container: 'mukanda postgres; rm' }))).toThrow(DeployConfigError)
  })

  it('a public URL that answers is said, not silent', async () => {
    const { host } = withPostgres()
    expect(await run(ctxOf(host, config()), { skip: ['tls'] })).toBe(0)
    expect(host.printed).toContain('OK https://mukanda.aipro.ao/api/readyz')
  })
})
