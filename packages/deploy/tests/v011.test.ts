/**
 * What the first production deploy (LexFirma, 2026-10-11) showed:
 * a credential prompt in the middle of `fetch`, steps that said nothing when
 * they worked, an install hint root could not run, and Prisma/Postgres steps
 * that ran by default in apps without either.
 */
import { describe, expect, it } from 'vitest'
import { apachePreflight, renderVhost } from '../src/apache.js'
import { INSTALL_COMMAND } from '../src/context.js'
import { backupDecision, migratesCentral, plan, preflight, run } from '../src/pipeline.js'
import { context, DIR, FakeHost, fail, jlist, lexfirmaConfig, ok } from './fake-host.js'

const ENV = `${DIR}/.env`
const BASE_ENV = 'NODE_ENV=production\nHOST=127.0.0.1\nPORT=3002\nAPP_SECRET=s3cr3t\nMAILER_URL=\nPROXYPAY_SECRET_TOKEN=tok\nPROXYPAY_CALLBACK_URL=https://lexfirma.aipro.ao/api/webhooks/proxypay\n'

function gitHost(remote: ReturnType<typeof ok>) {
  return new FakeHost()
    .put(ENV, BASE_ENV, 0o600)
    .on(({ command, args }) => {
      if (command !== 'git') return undefined
      if (args[0] === 'status') return ok('')
      if (args[0] === 'rev-parse') return ok(args[1] === '--abbrev-ref' ? 'master\n' : `${'a'.repeat(40)}\n`)
      if (args[0] === 'ls-remote') return remote
      return ok()
    })
    .on(({ command }) => (command === 'ss' ? ok('') : undefined))
    .on(({ command, args }) => (command === 'pm2' && args[0] === 'jlist' ? ok(jlist({ name: 'lexfirma-api', cwd: DIR })) : undefined))
    .on(({ command }) => (command === 'node' ? ok('v24.17.0') : undefined))
    .on(({ command }) => (command === 'pnpm' ? ok('11.8.0') : undefined))
}

const noApache = () => lexfirmaConfig({ proxy: { kind: 'none' } })

describe('git credentials are checked before the deploy starts, never prompted for unattended', () => {
  const needsCredentials = fail("fatal: could not read Username for 'https://github.com': terminal prompts disabled", 128)

  it('probes the remote with prompts disabled', async () => {
    const host = gitHost(ok('x\trefs/heads/master'))
    await preflight(context(host, noApache()), { skip: ['tls'] })
    const probe = host.calls.find((c) => c.args[0] === 'ls-remote')
    expect(probe?.args).toEqual(['ls-remote', '--exit-code', 'origin', 'refs/heads/master'])
    expect(probe?.options.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' })
  })

  it('at a terminal: a warning saying the fetch will ask, and how to store them once', async () => {
    const host = gitHost(needsCredentials)
    host.tty = true
    const { findings } = await preflight(context(host, noApache()), { skip: ['tls'] })
    expect(findings.find((f) => f.id === 'git')).toMatchObject({ level: 'warning', message: 'origin needs credentials: the fetch will ask for them', fix: expect.stringContaining('credential.helper store') })
  })

  it('without a terminal (cron, CI): an error before anything changes, instead of a hang half-way', async () => {
    const host = gitHost(needsCredentials)
    const ctx = context(host, noApache())
    await expect(run(ctx, { skip: ['tls'] })).rejects.toThrow(/preflight/)
    expect(host.transcript).toContain('needs credentials and nobody can type them here')
    expect(host.commands('git').some((c) => c.startsWith('git fetch'))).toBe(false)
  })

  it('a branch missing on the remote is an error; an unreachable remote a warning', async () => {
    const missing = await preflight(context(gitHost(fail('', 2)), noApache()), { skip: ['tls'] })
    expect(missing.findings.find((f) => f.id === 'git')).toMatchObject({ level: 'error', message: 'the branch "master" does not exist on origin' })
    const offline = await preflight(context(gitHost(fail('fatal: unable to access: Could not resolve host: github.com', 128)), noApache()), { skip: ['tls'] })
    expect(offline.findings.find((f) => f.id === 'git')).toMatchObject({ level: 'warning', message: expect.stringContaining('Could not resolve host') })
  })

  it('with --skip=fetch the remote is not probed', async () => {
    const host = gitHost(ok())
    await preflight(context(host, noApache()), { skip: ['tls', 'fetch'] })
    expect(host.commands('git').some((c) => c.startsWith('git ls-remote'))).toBe(false)
  })
})

describe('Prisma and Postgres steps run by default only when the app has them', () => {
  const bare = (extra: Partial<ReturnType<typeof lexfirmaConfig>> = {}) => lexfirmaConfig({ build: {}, migrate: {}, ...extra })

  it('prisma migrate deploy: with build.prisma, or when asked', () => {
    expect(migratesCentral(lexfirmaConfig())).toBe(true)
    expect(migratesCentral(bare())).toBe(false)
    expect(migratesCentral(bare({ migrate: { central: true } }))).toBe(true)
    expect(migratesCentral(lexfirmaConfig({ migrate: { central: false } }))).toBe(false)
  })

  it('the dump: when something is migrated and there is a Postgres to dump', () => {
    const pg = new Map([['DATABASE_URL', 'postgresql://u:p@127.0.0.1:5434/db']])
    expect(backupDecision(lexfirmaConfig(), pg)).toEqual({ run: true })
    expect(backupDecision(lexfirmaConfig(), new Map([['DATABASE_URL', 'mysql://u:p@h/db']]))).toEqual({ run: false, why: 'no Postgres database in the .env' })
    expect(backupDecision(lexfirmaConfig({ infra: { kind: 'docker', postgres: { image: 'postgres:16', port: 'auto', user: 'x', database: 'x', urlKey: 'DATABASE_URL', urlParams: {} } } }), new Map())).toEqual({ run: true })
    expect(backupDecision(bare(), pg)).toEqual({ run: false, why: 'nothing to migrate' })
    expect(backupDecision(bare({ backup: { beforeMigrate: true } }), new Map())).toEqual({ run: true })
    expect(backupDecision(lexfirmaConfig({ backup: { beforeMigrate: false } }), pg)).toEqual({ run: false, why: 'backup.beforeMigrate is false' })
    expect(backupDecision(lexfirmaConfig(), pg, ['backup'])).toEqual({ run: false, why: '--skip=backup' })
  })

  it('an app without Prisma or Postgres deploys without either, and says so', async () => {
    const host = gitHost(ok('x'))
      .on(({ command }) => (command === process.execPath ? ok('\n@@basalt-deploy@@{"ok":true,"trueKeys":[]}\n') : undefined))
      .on(({ command }) => (command === 'pm2' ? ok() : undefined))
    const ctx = context(host, bare({ proxy: { kind: 'none' } }))
    expect(await run(ctx, { skip: ['tls'] })).toBe(0)
    expect(host.commands('pnpm').some((c) => c.includes('prisma'))).toBe(false)
    expect(host.commands().some((c) => c.includes('pg_dump'))).toBe(false)
    expect(host.transcript).toContain('skipped: nothing to migrate')
    expect(host.transcript).toContain('nothing to migrate (no build.prisma, no migrate.tenants)')
  })

  it('plan says why the backup is skipped', async () => {
    const host = gitHost(ok('x'))
    await plan(context(host, bare({ proxy: { kind: 'none' } })), { skip: ['tls'] })
    expect(host.transcript).toContain('backup: skipped (nothing to migrate)')
    expect(host.transcript).toContain('migrate: nothing configured')
  })
})

describe('every step says what it did', () => {
  it('env, infra, validate and release each print a line when they succeed', async () => {
    const host = gitHost(ok('x'))
      .on(({ command }) => (command === process.execPath ? ok('\n@@basalt-deploy@@{"ok":true,"trueKeys":[]}\n') : undefined))
      .on(({ command }) => (command === 'pm2' ? ok() : undefined))
    const ctx = context(host, lexfirmaConfig({ proxy: { kind: 'none' }, backup: { beforeMigrate: false } }))
    expect(await run(ctx, { skip: ['tls'] })).toBe(0)
    const after = (step: string) => host.printed[host.printed.indexOf(`STEP ${step}`) + 1]
    expect(after('env')).toBe('OK .env unchanged')
    expect(after('infra')).toBe('OK nothing to start (external infra)')
    expect(after('validate')).toBe('OK .env is valid for src/env.ts')
    expect(after('release')).toBe('OK lexfirma-api restarted (pnpm run start, port 3002)')
  })
})

describe('the install hint is a command root can run', () => {
  it('uses node on the file, not pnpm exec', async () => {
    const host = new FakeHost()
    const ctx = context(host)
    host.put('/etc/apache2/sites-available/lexfirma.conf', renderVhost(ctx, 3000))
    host.files.set('/etc/apache2/sites-enabled/lexfirma.conf', { kind: 'symlink', target: '../sites-available/lexfirma.conf' })
    const fixes = (await apachePreflight(ctx, 3002)).map((f) => f.fix ?? '')
    expect(INSTALL_COMMAND).toBe('sudo node node_modules/@basaltkit/deploy/dist/bin.js install --user="$USER"')
    expect(fixes.every((f) => f.includes(INSTALL_COMMAND))).toBe(true)
    expect(fixes.join('\n')).not.toContain('pnpm exec')
  })
})
