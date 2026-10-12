import { describe, expect, it } from 'vitest'
import { backupDatabase, restoreCommand } from '../src/backup.js'
import { toolingFindings } from '../src/checks.js'
import { dockerInfra } from '../src/config.js'
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
    for (let i = 0; i < 3; i++) h.put(`${DIR}/backups/predeploy/2026010${i}T000000-aaaaaaa.dump`, 'old', 0o600)
    const ctx = context(h, acmeConfig({ backup: { keep: 2 } }))
    const file = await backupDatabase(ctx, new Map(), infra, 'b'.repeat(40))
    expect(h.commands('docker')).toEqual(['docker exec acme-pg pg_dump -U acme -d acme --format=custom --no-owner --no-acl'])
    expect(h.mode(file)).toBe(0o600)
    expect((await h.list(`${DIR}/backups/predeploy`)).sort()).toEqual(['20260102T000000-aaaaaaa.dump', '20261011T120000-bbbbbbb.dump'])
    expect(restoreCommand(ctx, infra, file)).toBe(`docker exec -i acme-pg pg_restore --clean --if-exists --no-owner -U acme -d acme < ${file}`)
  })

  it('refuses an empty dump and leaves no file behind', async () => {
    const h = new FakeHost().on(({ command }) => (command === 'docker' ? ok('') : undefined))
    await expect(backupDatabase(context(h), new Map(), infra, 'b'.repeat(40))).rejects.toThrow(/pg_dump failed — nothing was changed/)
    expect(await h.list(`${DIR}/backups/predeploy`)).toEqual([])
  })

  it('with external infra, needs the URL and prints a generic restore', async () => {
    const h = new FakeHost()
    const empty: InfraPlan = { services: [], env: [], findings: [], secrets: {} }
    await expect(backupDatabase(context(h), new Map(), empty, 'b'.repeat(40))).rejects.toThrow(/DATABASE_URL is not set/)
    expect(restoreCommand(context(h), empty, '/x.dump')).toMatch(/^pg_restore --clean/)
  })
})
