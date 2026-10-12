import { describe, expect, it } from 'vitest'
import { apacheInstall, apachePreflight, proxiedPorts, renderVhost } from '../src/apache.js'
import { covers, tlsFindings } from '../src/checks.js'
import { pm2Preflight, pm2Release } from '../src/pm2.js'
import { context, DIR, FakeHost, fail, jlist, ok, ss } from './fake-host.js'

const AVAILABLE = '/etc/apache2/sites-available/acme.conf'
const ENABLED = '/etc/apache2/sites-enabled/acme.conf'

describe('pm2', () => {
  it('C3: a process running from another clone is re-created here, not restarted (incident 3)', async () => {
    const host = new FakeHost()
      .on(({ command, args }) => (command === 'pm2' && args[0] === 'jlist' ? ok(jlist({ name: 'acme-api', cwd: '/home/ubuntu/acme' }, { name: 'api', cwd: '/srv/other' })) : undefined))
      .on(({ command }) => (command === 'pm2' ? ok() : undefined))
      .on(({ command }) => (command === 'ss' ? ok('') : undefined))
    const ctx = context(host)
    const findings = await pm2Preflight(ctx, 3002)
    expect(findings).toEqual([expect.objectContaining({ id: 'C3', level: 'warning' })])

    await pm2Release(ctx, new Map([['PORT', '3002']]))
    expect(host.commands('pm2').filter((c) => c !== 'pm2 jlist')).toEqual([
      'pm2 delete acme-api',
      `pm2 start pnpm --name acme-api --cwd ${DIR} -- run start`,
      'pm2 save',
    ])
  })

  it('restarts in place without the shell and without secrets (pm2 save would persist them), never naming another process (C4)', async () => {
    const host = new FakeHost()
      .on(({ command, args }) => (command === 'pm2' && args[0] === 'jlist' ? ok(jlist({ name: 'acme-api', cwd: DIR }, { name: 'api', cwd: '/srv/other' })) : undefined))
      .on(({ command }) => (command === 'pm2' ? ok() : undefined))
    await pm2Release(context(host), new Map([['NODE_ENV', 'production'], ['PORT', '3002'], ['APP_SECRET', 'never-in-pm2'], ['DATABASE_URL', 'postgresql://u:p@h/d']]))
    const restart = host.calls.find((c) => c.args[0] === 'restart')
    expect(restart?.args).toEqual(['restart', 'acme-api', '--update-env'])
    expect(restart?.options).toMatchObject({ inheritEnv: false, env: { NODE_ENV: 'production', PORT: '3002' } })
    expect(Object.keys(restart?.options.env ?? {})).toEqual(['NODE_ENV', 'PORT'])
    expect(host.commands('pm2').join('\n')).not.toMatch(/\b(api|all)$/m)
  })

  it('C1: refuses a port a foreign process listens on — and accepts our own old process', async () => {
    const host = new FakeHost()
      .on(({ command, args }) => (command === 'pm2' && args[0] === 'jlist' ? ok(jlist({ name: 'acme-api', cwd: '/home/ubuntu/old' })) : undefined))
      .on(({ command }) => (command === 'ss' ? ok(ss([3000], [3002, 77])) : undefined))
    host.files.set('/proc/77/cwd', { kind: 'symlink', target: '/home/ubuntu/old' })
    const ctx = context(host)
    expect((await pm2Preflight(ctx, 3002)).filter((f) => f.id === 'C1')).toEqual([])
    // Apache (root) on :3000: no pid visible to us, so not ours.
    expect((await pm2Preflight(ctx, 3000)).filter((f) => f.id === 'C1')).toEqual([expect.objectContaining({ level: 'error' })])
  })

  it('reports pm2 missing instead of failing later', async () => {
    const host = new FakeHost().on(({ command }) => (command === 'pm2' ? fail('not found', 127) : undefined))
    expect(await pm2Preflight(context(host), 3002)).toEqual([expect.objectContaining({ id: 'C9' })])
  })
})

describe('apache', () => {
  const vhostHost = () => new FakeHost()

  it('renders a vhost that proxies the API prefix to the app port and serves the tenants wildcard', () => {
    const text = renderVhost(context(new FakeHost()), 3002)
    expect(proxiedPorts(text)).toEqual([3002])
    expect(text).toContain('ServerAlias *.acme.example.com')
    expect(text).toContain(`DocumentRoot ${DIR}/web/dist`)
    expect(text).toContain('ProxyPass /api/ http://127.0.0.1:3002/ upgrade=websocket')
    expect(text).toContain('/etc/letsencrypt/live/acme.example.com/fullchain.pem')
  })

  it('C1: the vhost proxies to a port the app does not listen on (incident 1)', async () => {
    const host = vhostHost()
    const ctx = context(host)
    host.put(AVAILABLE, renderVhost(ctx, 3000))
    host.files.set(ENABLED, { kind: 'symlink', target: '../sites-available/acme.conf' })
    const findings = await apachePreflight(ctx, 3002)
    expect(findings.find((f) => f.id === 'C1')?.message).toBe('the vhost proxies to 127.0.0.1:3000, but the app listens on 3002')
    // The difference is shown for audit, and the file is left alone.
    expect(findings.find((f) => f.id === 'vhost')).toMatchObject({ level: 'warning' })
    expect(host.file(AVAILABLE)).toBe(renderVhost(ctx, 3000))
  })

  it('C2: a copy in sites-enabled is an error, and the copy is what is checked (incident 2)', async () => {
    const host = vhostHost()
    const ctx = context(host)
    host.put(AVAILABLE, renderVhost(ctx, 3002))
    host.put(ENABLED, renderVhost(ctx, 3000))
    const findings = await apachePreflight(ctx, 3002)
    expect(findings.find((f) => f.id === 'C2')?.message).toMatch(/regular file.*DIFFERS/)
    expect(findings.find((f) => f.id === 'C1')).toBeDefined()
  })

  it('a correctly installed vhost has nothing to say', async () => {
    const host = vhostHost()
    const ctx = context(host)
    host.put(AVAILABLE, renderVhost(ctx, 3002))
    host.files.set(ENABLED, { kind: 'symlink', target: '../sites-available/acme.conf' })
    expect(await apachePreflight(ctx, 3002)).toEqual([])
  })

  it('install replaces a copy with a link, and puts everything back when configtest fails', async () => {
    const host = vhostHost()
      .on(({ command }) => (command === 'a2enmod' ? ok() : undefined))
      .on(({ command }) => (command === 'apachectl' ? fail('Syntax error on line 3') : undefined))
    const ctx = context(host)
    host.put(AVAILABLE, 'old available\n')
    host.put(ENABLED, 'old copy\n')
    host.confirmations = [true]
    await expect(apacheInstall(ctx, 3002, '/var/lib/basalt/acme/install-backups')).rejects.toThrow(/configtest failed — every file was put back/)
    expect(host.file(AVAILABLE)).toBe('old available\n')
    expect(host.file(ENABLED)).toBe('old copy\n')
    expect(host.commands('systemctl')).toEqual([])
  })

  it('install writes, links, tests and reloads', async () => {
    const host = vhostHost().on(({ command }) => (['a2enmod', 'apachectl', 'systemctl'].includes(command) ? ok() : undefined))
    const ctx = context(host)
    await apacheInstall(ctx, 3002, '/backups')
    expect(host.file(AVAILABLE)).toBe(renderVhost(ctx, 3002))
    expect(await host.readlink(ENABLED)).toBe('../sites-available/acme.conf')
    expect(host.commands('systemctl')).toEqual(['systemctl reload apache2'])
  })

  it('install never overwrites a changed vhost without a yes', async () => {
    const host = vhostHost()
    host.put(AVAILABLE, 'hand-edited\n')
    await expect(apacheInstall(context(host), 3002, '/backups')).rejects.toThrow(/declined/)
    expect(host.file(AVAILABLE)).toBe('hand-edited\n')
  })
})

describe('C8 — certificates as a browser sees them', () => {
  it('wildcards cover exactly one label', () => {
    expect(covers('*.acme.example.com', 'acme.acme.example.com')).toBe(true)
    expect(covers('*.acme.example.com', 'acme.example.com')).toBe(false)
    expect(covers('*.acme.example.com', 'a.b.acme.example.com')).toBe(false)
    expect(covers('acme.example.com', 'ACME.example.com')).toBe(true)
  })

  it('a tenant host served the apex certificate is reported (incident 8)', async () => {
    const host = new FakeHost()
    host.certificates.set('*', { names: ['acme.example.com'], validTo: new Date('2027-01-01'), trusted: true })
    const findings = await tlsFindings(context(host))
    expect(findings).toEqual([expect.objectContaining({ id: 'C8', level: 'warning', message: expect.stringMatching(/tenant host .* covers only acme\.example\.com/) })])
    expect(findings[0]?.fix).toMatch(/DNS-only/)
  })

  it('an untrusted or expiring certificate is reported', async () => {
    const host = new FakeHost()
    host.certificates.set('*', { names: ['acme.example.com', '*.acme.example.com'], validTo: new Date('2026-10-20'), trusted: false, trustError: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })
    const messages = (await tlsFindings(context(host))).map((f) => f.message)
    expect(messages.some((m) => /not trusted/.test(m))).toBe(true)
    expect(messages.some((m) => /expires in 8 day/.test(m))).toBe(true)
  })
})

describe('C8 — an untrusted chain fails the handshake and says so', () => {
  it('suggests the Let\'s Encrypt certificate, not DNS', async () => {
    const host = new FakeHost()
    host.certificates.set('*', { error: 'certificate not trusted by browsers (UNABLE_TO_VERIFY_LEAF_SIGNATURE)' })
    const findings = await tlsFindings(context(host))
    expect(findings).toHaveLength(2)
    expect(findings.every((f) => /Let's Encrypt/.test(f.fix ?? ''))).toBe(true)
  })
})
