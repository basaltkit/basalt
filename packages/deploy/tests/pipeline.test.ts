import { describe, expect, it } from 'vitest'
import { renderVhost } from '../src/apache.js'
import { DeployError } from '../src/context.js'
import { dockerInfra } from '../src/config.js'
import { envCommand, install, plan, rollback, run, status } from '../src/pipeline.js'
import { readReleases } from '../src/state.js'
import { context, DIR, FakeHost, fail, jlist, acmeConfig, ok } from './fake-host.js'

const OLD = 'a'.repeat(40)
const NEW = 'b'.repeat(40)
const ENV = `${DIR}/.env`
const GOOD_ENV = 'NODE_ENV=production\nHOST=127.0.0.1\nPORT=3002\nAPP_SECRET=s3cr3t\nMAILER_URL=\nPAYCO_SECRET_TOKEN=tok-SECRET\nPAYCO_CALLBACK_URL=https://acme.example.com/api/webhooks/payco\n'

interface Server {
  host: FakeHost
  head: () => string
}

/**
 * A server where Acme is already installed and healthy at OLD, and the
 * remote has NEW. Options break one thing at a time.
 */
function server(options: {
  dirty?: string
  migrations?: string[]
  buildFails?: boolean
  healthyAt?: (sha: string) => boolean
  publicStatus?: number
  trueKeys?: string[]
  env?: string
  remote?: ReturnType<typeof ok>
} = {}): Server {
  let head = OLD
  const host = new FakeHost().put(ENV, options.env ?? GOOD_ENV, 0o600)
  host.put(`${DIR}/package.json`, JSON.stringify({ packageManager: 'pnpm@11.8.0', engines: { node: '>=22.5.0' } }))
  const ctx = context(host)
  host.put('/etc/apache2/sites-available/acme.conf', renderVhost(ctx, 3002))
  host.files.set('/etc/apache2/sites-enabled/acme.conf', { kind: 'symlink', target: '../sites-available/acme.conf' })
  host.certificates.set('*', { names: ['acme.example.com', '*.acme.example.com'], validTo: new Date('2027-01-01'), trusted: true })
  host.http = (url) => {
    if (url.startsWith('https://')) return { status: options.publicStatus ?? 200 }
    return (options.healthyAt ?? (() => true))(head) ? { status: 200 } : { error: 'ECONNREFUSED' }
  }
  host
    .on(({ command, args }) => {
      if (command !== 'git') return undefined
      const [verb, ...rest] = args
      if (verb === 'status') return ok(options.dirty ?? '')
      if (verb === 'rev-parse') return ok(rest[0] === '--abbrev-ref' ? 'master\n' : `${head}\n`)
      if (verb === 'fetch') return ok()
      if (verb === 'ls-remote') return options.remote ?? ok(`${NEW}\trefs/heads/master\n`)
      if (verb === 'merge') { head = NEW; return ok() }
      if (verb === 'reset') { head = rest[1] as string; return ok() }
      if (verb === 'diff') return ok((options.migrations ?? []).map((m) => `prisma/migrations/${m}/migration.sql`).join('\n'))
      return undefined
    })
    .on(({ command }) => (command === 'ss' ? ok('') : undefined))
    .on(({ command, args }) => (command === 'pm2' && args[0] === 'jlist' ? ok(jlist({ name: 'acme-api', cwd: DIR })) : undefined))
    .on(({ command }) => (command === 'pm2' ? ok() : undefined))
    .on(({ command, args }) => (command === 'node' && args[0] === '--version' ? ok('v24.17.0\n') : undefined))
    .on(({ command, args }) => (command === 'pnpm' && args[0] === '--version' ? ok('11.8.0\n') : undefined))
    .on(({ command, args }) => (command === 'pnpm' && args[0] === 'install' && options.buildFails && head === NEW ? fail('', 1) : undefined))
    .on(({ command }) => (command === 'pnpm' ? ok() : undefined))
    .on(({ command }) => (command === process.execPath
      ? ok(`\n@@basalt-deploy@@${JSON.stringify({ ok: true, trueKeys: options.trueKeys ?? [] })}\n`)
      : undefined))
    .on(({ command }) => (command === 'pg_dump' ? ok('PGDMP-binary') : undefined))
  return { host, head: () => head }
}

const config = () => acmeConfig({ backup: { urlKey: 'DATABASE_URL' } })

describe('basalt-deploy run', () => {
  it('runs every step in order and records a healthy release', async () => {
    const { host, head } = server({ env: `${GOOD_ENV}DATABASE_URL=postgresql://acme:pw@127.0.0.1:5434/acme?schema=public\n` })
    const ctx = context(host, config())
    expect(await run(ctx)).toBe(0)
    expect(head()).toBe(NEW)
    expect(host.printed.filter((l) => l.startsWith('STEP')).map((l) => l.slice(5))).toEqual(
      ['preflight', 'fetch', 'env', 'infra', 'build', 'validate', 'backup', 'migrate', 'release', 'health', 'record'],
    )
    expect(host.commands('pnpm').filter((c) => c !== 'pnpm --version')).toEqual([
      'pnpm install --frozen-lockfile',
      'pnpm exec prisma generate --config prisma.config.ts',
      'pnpm --dir web run build',
      'pnpm exec prisma migrate deploy',
      'pnpm run basalt tenant:migrate',
    ])
    // The install runs without NODE_ENV (devDependencies), never with a version-specific flag.
    expect(host.calls.find((c) => c.args[0] === 'install')?.options.unset).toEqual(['NODE_ENV'])
    // pg_dump never sees the password on its command line, nor Prisma's ?schema=.
    const dump = host.calls.find((c) => c.command === 'pg_dump')
    expect(dump?.args.join(' ')).toBe('--dbname postgresql://acme@127.0.0.1:5434/acme --format=custom --no-owner --no-acl')
    expect(dump?.options.env).toEqual({ PGPASSWORD: 'pw' })
    const [release] = await readReleases(ctx)
    expect(release).toMatchObject({ sha: NEW, previous: OLD, status: 'ok', user: 'deployer' })
    expect(release?.backup).toMatch(/backups\/predeploy\/20261011T120000-bbbbbbb\.dump$/)
    expect(host.transcript).not.toContain('tok-SECRET')
    expect(host.transcript).not.toContain('s3cr3t')
  })

  it('build.script compiles the app after prisma generate, before the web (start runs dist/)', async () => {
    const { host } = server({ env: `${GOOD_ENV}DATABASE_URL=postgresql://acme:pw@127.0.0.1:5434/acme\n` })
    const ctx = context(host, acmeConfig({ backup: { urlKey: 'DATABASE_URL' }, build: { prisma: ['prisma.config.ts'], script: 'build', web: 'web' } }))
    expect(await run(ctx)).toBe(0)
    expect(host.commands('pnpm').filter((c) => c !== 'pnpm --version').slice(0, 4)).toEqual([
      'pnpm install --frozen-lockfile',
      'pnpm exec prisma generate --config prisma.config.ts',
      'pnpm run build',
      'pnpm --dir web run build',
    ])
  })

  it('stops at preflight with nothing changed when the checkout has local edits', async () => {
    const { host, head } = server({ dirty: ' M src/app.ts' })
    await expect(run(context(host, config()))).rejects.toThrow(DeployError)
    expect(head()).toBe(OLD)
    expect(host.commands('git').some((c) => c.startsWith('git fetch'))).toBe(false)
    expect(host.commands('pm2').filter((c) => c !== 'pm2 jlist')).toEqual([])
    expect(host.file(ENV)).toBe(GOOD_ENV)
  })

  it('rolls the code back and restarts it when the new release is not healthy', async () => {
    const { host, head } = server({ healthyAt: (sha) => sha === OLD })
    const ctx = context(host, acmeConfig({ backup: { beforeMigrate: false } }))
    expect(await run(ctx)).toBe(1)
    expect(head()).toBe(OLD)
    expect(host.commands('git')).toContain(`git reset --hard ${OLD}`)
    expect(host.commands('pm2').filter((c) => c.startsWith('pm2 restart'))).toHaveLength(2)
    expect(host.transcript).toContain('back on aaaaaaa')
    expect((await readReleases(ctx))[0]).toMatchObject({ sha: NEW, status: 'rolled-back' })
  })

  it('never rolls back automatically over a destructive migration; prints the restore instead', async () => {
    const { host, head } = server({ healthyAt: (sha) => sha === OLD, migrations: ['20261011_drop_legacy'] })
    const ctx = context(host, acmeConfig({ destructive: ['20261011_drop_legacy'] }))
    host.put(ENV, `${GOOD_ENV}DATABASE_URL=postgresql://acme:pw@127.0.0.1:5434/acme\n`, 0o600)
    expect(await run(ctx)).toBe(1)
    expect(head()).toBe(NEW)
    expect(host.transcript).toContain('marked destructive')
    expect(host.transcript).toMatch(/pg_restore --clean --if-exists/)
    expect((await readReleases(ctx))[0]).toMatchObject({ status: 'failed', migrations: ['20261011_drop_legacy'] })
  })

  it('a failed build restores the code on disk and releases nothing', async () => {
    const { host, head } = server({ buildFails: true })
    await expect(run(context(host, acmeConfig({ backup: { beforeMigrate: false } })))).rejects.toThrow(/pnpm install --frozen-lockfile failed/)
    expect(head()).toBe(OLD)
    expect(host.commands('pm2').filter((c) => c.startsWith('pm2 restart') || c.startsWith('pm2 start'))).toEqual([])
    expect(host.commands('pnpm').some((c) => c.includes('migrate'))).toBe(false)
  })

  it('C6 in the pipeline: a "0" read as true stops the deploy before migrating', async () => {
    const { host, head } = server({ env: `${GOOD_ENV}PAYMENTS_FAKE=0\n`, trueKeys: ['PAYMENTS_FAKE'] })
    await expect(run(context(host, acmeConfig({ backup: { beforeMigrate: false } })))).rejects.toThrow(/validate/)
    expect(host.transcript).toContain('[C6] PAYMENTS_FAKE="0" is read as TRUE')
    expect(head()).toBe(OLD)
    expect(host.commands('pnpm').some((c) => c.includes('migrate'))).toBe(false)
  })

  it('healthy on 127.0.0.1 but not through the proxy: exit 1, recorded, not rolled back', async () => {
    const { host, head } = server({ publicStatus: 502 })
    const ctx = context(host, acmeConfig({ backup: { beforeMigrate: false } }))
    expect(await run(ctx)).toBe(1)
    expect(head()).toBe(NEW)
    expect(host.transcript).toContain('the proxy, DNS or TLS, not the code')
    expect((await readReleases(ctx))[0]).toMatchObject({ status: 'public-unreachable' })
  })
})

describe('basalt-deploy plan', () => {
  it('prints every step and changes nothing', async () => {
    const { host, head } = server({ env: 'PAYCO_FAKE=0\n' })
    const before = new Map([...host.files].map(([k, v]) => [k, JSON.stringify(v)]))
    await plan(context(host, config()))
    expect(head()).toBe(OLD)
    expect(new Map([...host.files].map(([k, v]) => [k, JSON.stringify(v)]))).toEqual(before)
    expect(host.commands('git').some((c) => /fetch|merge|reset/.test(c))).toBe(false)
    expect(host.commands('pm2').filter((c) => c !== 'pm2 jlist')).toEqual([])
    expect(host.transcript).toContain('env: remove PAYCO_FAKE')
    expect(host.transcript).toContain('env: ask PAYCO_SECRET_TOKEN')
    expect(host.prompts).toEqual([])
  })
})

describe('basalt-deploy rollback', () => {
  it('goes back to the last healthy release, code only', async () => {
    const { host, head } = server()
    const ctx = context(host, acmeConfig({ backup: { beforeMigrate: false } }))
    expect(await run(ctx)).toBe(0)
    expect(head()).toBe(NEW)
    expect(await rollback(ctx)).toBe(0)
    expect(head()).toBe(OLD)
  })
})

describe('basalt-deploy env', () => {
  it('writes the .env, validates it, and needs nothing else', async () => {
    const { host } = server({ env: 'PAYCO_FAKE=0\n' })
    host.answers = ['', 'tok-FROM-PROMPT']
    const ctx = context(host, config())
    expect(await envCommand(ctx)).toBe(0)
    expect(host.file(ENV)).toMatch(/^PORT=3002$/m)
    expect(host.file(ENV)).not.toContain('PAYCO_FAKE')
    expect(host.transcript).toContain('.env ready')
    expect(host.transcript).not.toContain('tok-FROM-PROMPT')
  })

  it('stops on a broken line before writing anything', async () => {
    const { host } = server({ env: 'A="open\n' })
    await expect(envCommand(context(host, config()))).rejects.toThrow(DeployError)
    expect(host.file(ENV)).toBe('A="open\n')
  })

  it('lists the answers it could not get without a terminal', async () => {
    const { host } = server({ env: '' })
    await expect(envCommand(context(host, config()))).rejects.toThrow(/no answer for PAYCO_SECRET_TOKEN/)
  })
})

describe('basalt-deploy install', () => {
  const installable = () => {
    const { host } = server()
    host.files.delete('/etc/apache2/sites-available/acme.conf')
    host.files.delete('/etc/apache2/sites-enabled/acme.conf')
    host.userId = 0
    host
      .on(({ command }) => (['chown', 'a2enmod', 'apachectl', 'systemctl'].includes(command) ? ok() : undefined))
      .on(({ command }) => (command === 'id' ? ok('deployer docker sudo\n') : undefined))
    return host
  }

  it('refuses without root, without a user, as root, and before the .env has a PORT', async () => {
    const { host } = server()
    await expect(install(context(host), 'deployer')).rejects.toThrow(/needs root/)
    host.userId = 0
    await expect(install(context(host), undefined)).rejects.toThrow(/--user/)
    await expect(install(context(host), 'root')).rejects.toThrow(/never root/)
    host.put(ENV, 'A=1\n')
    await expect(install(context(host), 'deployer')).rejects.toThrow(/no PORT/)
  })

  it('creates the state directory for the app user, installs the vhost, and warns about the docker group', async () => {
    const host = installable()
    host.put(`${DIR}/.basalt/releases.json`, '[]\n')
    const ctx = context(host, acmeConfig({ infra: dockerInfra('acme') }))
    expect(await install(ctx, 'deployer')).toBe(0)
    expect(host.commands('chown')).toEqual(['chown -R deployer: /var/lib/basalt/acme'])
    expect(host.file('/var/lib/basalt/acme/releases.json')).toBe('[]\n')
    expect(host.file('/etc/basalt/acme.json')).toBe('{}\n')
    expect(await host.readlink('/etc/apache2/sites-enabled/acme.conf')).toBe('../sites-available/acme.conf')
    expect(host.transcript).toMatch(/deployer is in the docker group: that is root/)
    expect(host.commands('usermod')).toEqual([])
  })

  it('points at rootless Docker when the user is not in the docker group', async () => {
    const host = installable()
    host.handlers.unshift(({ command }) => (command === 'id' ? ok('deployer\n') : undefined))
    expect(await install(context(host, acmeConfig({ infra: dockerInfra('acme') })), 'deployer')).toBe(0)
    expect(host.transcript).toContain("rootless Docker")
  })

  it('reports a chown that fails', async () => {
    const host = installable()
    host.handlers.unshift(({ command }) => (command === 'chown' ? fail('invalid user') : undefined))
    await expect(install(context(host), 'nobody-here')).rejects.toThrow(/chown nobody-here/)
  })
})

describe('basalt-deploy status', () => {
  it('lists the recorded releases and the process', async () => {
    const { host } = server()
    const ctx = context(host, acmeConfig({ backup: { beforeMigrate: false } }))
    await run(ctx)
    expect(await status(ctx)).toBe(0)
    expect(host.transcript).toMatch(/bbbbbbb\s+ok/)
    expect(host.transcript).toContain(`pm2 acme-api: online (pid 4242, ${DIR})`)
  })
})
