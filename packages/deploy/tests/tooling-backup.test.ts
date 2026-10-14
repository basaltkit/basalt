import { describe, expect, it } from 'vitest'
import { backupDatabase, backupPlaceFindings, restoreCommand } from '../src/backup.js'
import { toolingFindings } from '../src/checks.js'
import { compose, dockerInfra } from '../src/config.js'
import { clearHold, readHold } from '../src/state.js'
import type { InfraPlan } from '../src/infra.js'
import { context, DIR, FakeHost, fail, acmeConfig, ok } from './fake-host.js'

describe('C9 — the toolchain', () => {
  const host = (node: string, pnpm: string | null, docker = true) => new FakeHost()
    .put(`${DIR}/package.json`, JSON.stringify({ packageManager: 'pnpm@11.8.0', engines: { node: '>=22.5.0' } }))
    .on(({ command }) => (command === 'node' ? ok(`${node}\n`) : undefined))
    .on(({ command }) => (command === 'pnpm' ? (pnpm ? ok(`${pnpm}\n`) : fail('not found', 127)) : undefined))
    .on(({ command }) => (command === 'docker' ? (docker ? ok('Docker Compose version v2.29') : fail()) : undefined))

  it('passes a matching toolchain', async () => {
    expect(await toolingFindings(context(host('v24.17.0', '11.8.0')))).toEqual([])
  })

  it('reports an old node, another pnpm major (pnpm 11 refused a pnpm 10 flag), and missing tools', async () => {
    const messages = (await toolingFindings(context(host('v20.11.0', '10.4.1'), acmeConfig({ infra: dockerInfra('acme') }))))
      .map((f) => f.message)
    expect(messages).toEqual([
      'node v20.11.0 is older than engines.node (>=22.5.0)',
      'pnpm 10.4.1 on this server, but package.json declares pnpm@11.8.0',
    ])
    const missing = (await toolingFindings(context(host('', null, false), acmeConfig({ infra: dockerInfra('acme') })))).map((f) => f.message)
    expect(missing).toEqual(['node is not on PATH', 'pnpm is not on PATH', 'docker compose is not available to this user'])
  })

  it('reports an unreadable package.json', async () => {
    const h = host('v24.17.0', '11.8.0').put(`${DIR}/package.json`, '{')
    expect((await toolingFindings(context(h))).map((f) => f.message)).toContain('package.json is not valid JSON')
  })
})

describe('backup with dedicated infra', () => {
  const infra: InfraPlan = {
    services: [{ service: 'postgres', container: 'acme-pg', volume: 'acme_acme-pg-data', action: 'adopt', port: 5434, user: 'acme', database: 'acme', source: 'container' }],
    env: [], findings: [], secrets: {},
  }

  it('dumps inside the container (same pg_dump major as the server) and keeps the newest N', async () => {
    const h = new FakeHost().on(({ command }) => (command === 'docker' ? ok('PGDMP') : undefined))
    for (let i = 0; i < 3; i++) h.put(`${DIR}/.basalt/backups/2026010${i}T000000-aaaaaaa.dump`, 'old', 0o600)
    const ctx = context(h, acmeConfig({ backup: { keep: 2 } }))
    const file = await backupDatabase(ctx, new Map(), infra, 'b'.repeat(40))
    expect(h.commands('docker')).toEqual(['docker exec acme-pg pg_dump -U acme -d acme --format=custom --no-owner --no-acl'])
    expect(h.mode(file)).toBe(0o600)
    expect((await h.list(`${DIR}/.basalt/backups`)).sort()).toEqual(['20260102T000000-aaaaaaa.dump', '20261011T120000-bbbbbbb.dump'])
    expect((await h.stat(`${DIR}/.basalt/backups`))?.mode).toBe(0o700)
    expect(restoreCommand(ctx, infra, file)).toBe(`docker exec -i acme-pg pg_restore --clean --if-exists --no-owner -U acme -d acme < ${file}`)
  })

  it('backup.dir keeps the old place inside the checkout; a loose existing directory is made 0700', async () => {
    const h = new FakeHost().on(({ command }) => (command === 'docker' ? ok('PGDMP') : undefined))
    h.dir(`${DIR}/backups/predeploy`, 0o755)
    const file = await backupDatabase(context(h, acmeConfig({ backup: { dir: 'backups/predeploy' } })), new Map(), infra, 'b'.repeat(40))
    expect(file).toBe(`${DIR}/backups/predeploy/20261011T120000-bbbbbbb.dump`)
    expect((await h.stat(`${DIR}/backups/predeploy`))?.mode).toBe(0o700)
  })

  it('refuses an empty dump and leaves no file behind', async () => {
    const h = new FakeHost().on(({ command }) => (command === 'docker' ? ok('') : undefined))
    await expect(backupDatabase(context(h), new Map(), infra, 'b'.repeat(40))).rejects.toThrow(/pg_dump failed — nothing was changed/)
    expect(await h.list(`${DIR}/.basalt/backups`)).toEqual([])
  })

  it('with external infra, needs the URL and prints a generic restore', async () => {
    const h = new FakeHost()
    const empty: InfraPlan = { services: [], env: [], findings: [], secrets: {} }
    await expect(backupDatabase(context(h), new Map(), empty, 'b'.repeat(40))).rejects.toThrow(/DATABASE_URL is not set/)
    expect(restoreCommand(context(h), empty, '/x.dump')).toMatch(/^pg_restore --clean/)
  })
})

describe('where the dumps go, before install', () => {
  const ignoredBy = (code: number) => new FakeHost().on(({ command, args }) => (command === 'git' && args[0] === 'check-ignore' ? { code, stdout: '', stderr: '' } : undefined))

  it('inside the checkout and not ignored by git, or in a Docker build context: said before a dump is written', async () => {
    const host = ignoredBy(1).put(`${DIR}/Dockerfile`, 'FROM node\nCOPY . .\n')
    const findings = await backupPlaceFindings(context(host))
    expect(findings.map((f) => f.message)).toEqual([
      `database dumps go to ${DIR}/.basalt/backups, inside the checkout, and git does not ignore them`,
      `database dumps go to ${DIR}/.basalt/backups, inside the Docker build context: a COPY . . puts them in the image`,
    ])
    expect(findings[0]?.fix).toContain('add /.basalt/ to .gitignore, or run install once (dumps then go to /var/lib/basalt/acme/backups')
    expect(host.commands('git')).toEqual(['git check-ignore -q --no-index -- .basalt/backups/x.dump'])
  })

  it('quiet when git and .dockerignore keep them out, when there is no Docker build, and after install', async () => {
    expect(await backupPlaceFindings(context(ignoredBy(0).put(`${DIR}/Dockerfile`, '').put(`${DIR}/.dockerignore`, 'node_modules\n/.basalt/\n')))).toEqual([])
    expect(await backupPlaceFindings(context(ignoredBy(0)))).toEqual([])
    const composeApp = acmeConfig({ runtime: compose({ file: 'compose.yml', images: [{ tag: 'acme', dockerfile: 'Dockerfile', env: 'ACME_IMAGE' }], upstream: { service: 'api', port: 3005 } }) })
    expect((await backupPlaceFindings(context(ignoredBy(0), composeApp))).map((f) => f.id)).toEqual(['dumps'])
    const installed = ignoredBy(1)
    expect(await backupPlaceFindings({ ...context(installed), stateDir: '/var/lib/basalt/acme' })).toEqual([])
    expect(installed.commands('git')).toEqual([])
  })

  it('dumps left in the old place (backups/predeploy) are pointed out, unless backup.dir keeps it', async () => {
    const host = ignoredBy(0).put(`${DIR}/backups/predeploy/20261001-abc.dump`, 'x').put(`${DIR}/backups/predeploy/notes.txt`, 'x')
    const ctx = { ...context(host), stateDir: '/var/lib/basalt/acme' }
    expect((await backupPlaceFindings(ctx)).map((f) => f.message)).toEqual([`1 dump(s) left in ${DIR}/backups/predeploy (the old place): new dumps go to /var/lib/basalt/acme/backups, and nothing prunes these`])
    expect((await backupPlaceFindings(ctx))[0]?.fix).toBe(`move them next to the new ones (install -d -m 700 /var/lib/basalt/acme/backups && mv ${DIR}/backups/predeploy/*.dump /var/lib/basalt/acme/backups/) or delete them`)
    expect(await backupPlaceFindings({ ...ctx, config: acmeConfig({ backup: { dir: 'backups/predeploy' } }) })).toEqual([])
  })

  it('says when /var/lib/basalt is there but this app\'s state is not reachable (the deploy falls back to the checkout)', async () => {
    const fallback = context(ignoredBy(0).dir('/var/lib/basalt', 0o700))
    const findings = (await backupPlaceFindings(fallback)).filter((f) => f.id === 'state-dir')
    expect(findings.map((f) => f.message)).toEqual([`/var/lib/basalt/acme is missing or not reachable by this user: the deploy's state (release history, lock, dumps) stays in ${DIR}/.basalt, inside the checkout`])
    expect(findings[0]?.fix).toMatch(/install-plan/)
    // No /var/lib/basalt at all (never installed), or the state is there: quiet.
    expect((await backupPlaceFindings(context(ignoredBy(0)))).filter((f) => f.id === 'state-dir')).toEqual([])
    expect((await backupPlaceFindings({ ...context(ignoredBy(0).dir('/var/lib/basalt', 0o755)), stateDir: '/var/lib/basalt/acme' })).filter((f) => f.id === 'state-dir')).toEqual([])
  })

  it('a hold written before install is still read, and cleared, from the checkout', async () => {
    const host = new FakeHost().put(`${DIR}/.basalt/hold.json`, JSON.stringify({ sha: 'b'.repeat(40), at: '', actor: 'alice', note: 'rolled back' }))
    const ctx = { ...context(host), stateDir: '/var/lib/basalt/acme' }
    expect(await readHold(ctx)).toMatchObject({ sha: 'b'.repeat(40) })
    await clearHold(ctx)
    expect(await readHold(ctx)).toBeUndefined()
    expect(host.files.has(`${DIR}/.basalt/hold.json`)).toBe(false)
  })
})
