import { describe, expect, it } from 'vitest'
import { run } from '../src/pipeline.js'
import { readReleases } from '../src/state.js'
import { acmeConfig, context, DIR, fail } from './fake-host.js'
import { ENV, GOOD_ENV, OLD, server } from './acme-server.js'

const failMigration = (host: ReturnType<typeof server>['host']) =>
  host.handlers.unshift(({ command, args }) => (command === 'pnpm' && args.join(' ') === 'exec prisma migrate deploy' ? fail('P3009 migrate found failed migrations') : undefined))

describe('a migration that fails', () => {
  it('puts the code back, records failed-migration and prints the restore of the dump taken before it', async () => {
    const { host, head } = server({ migrations: ['20261011_add_index'] })
    host.put(ENV, `${GOOD_ENV}DATABASE_URL=postgresql://acme:pw@127.0.0.1:5434/acme\n`, 0o600)
    failMigration(host)
    const ctx = context(host, acmeConfig({ backup: { urlKey: 'DATABASE_URL' } }))
    await expect(run(ctx)).rejects.toThrow(/prisma migrate deploy failed/)
    expect(head()).toBe(OLD)
    const [release] = await readReleases(ctx)
    expect(release).toMatchObject({ status: 'failed-migration', migrations: ['20261011_add_index'] })
    expect(release?.backup).toMatch(/\.dump$/)
    expect(host.transcript).toContain('the database may be part-way migrated, and the code is back on aaaaaaa')
    expect(host.transcript).toContain(`to put the database back as it was before this deploy: pg_restore --clean --if-exists --no-owner --dbname "<the database URL, without ?schema=>" ${release?.backup}`)
    // The password never reaches the screen.
    expect(host.transcript).not.toContain(':pw@')
    expect(host.commands('pm2').filter((c) => /restart|start/.test(c))).toEqual([])
  })

  it('says so when no dump was taken', async () => {
    const { host } = server()
    failMigration(host)
    const ctx = context(host, acmeConfig({ backup: { beforeMigrate: false } }))
    await expect(run(ctx)).rejects.toThrow(/prisma migrate deploy failed/)
    expect((await readReleases(ctx))[0]).toMatchObject({ status: 'failed-migration' })
    expect(host.transcript).toContain('no dump was taken before this migration')
    expect(host.files.has(`${DIR}/.basalt/deploy.lock`)).toBe(false)
  })
})
