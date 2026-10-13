import { describe, expect, it } from 'vitest'
import { rollback, run, status } from '../src/pipeline.js'
import { lastGood, readHold, readReleases, type Release } from '../src/state.js'
import { acmeConfig, context, jlist, ok } from './fake-host.js'
import { NEW, OLD, server } from './acme-server.js'

const config = () => acmeConfig({ backup: { beforeMigrate: false } })
const rel = (sha: string, status: Release['status']): Release => ({ sha, at: '', user: '', status, migrations: [] })

describe('lastGood', () => {
  it('is the newest healthy release other than the current one', () => {
    expect(lastGood([rel('a', 'ok'), rel('b', 'ok'), rel('c', 'ok')], 'c')?.sha).toBe('b')
  })

  it('skips a commit that failed its health check after it was healthy', () => {
    expect(lastGood([rel('a', 'ok'), rel('b', 'ok'), rel('b', 'rollback-unhealthy'), rel('c', 'ok')], 'c')?.sha).toBe('a')
    expect(lastGood([rel('a', 'ok'), rel('b', 'ok'), rel('b', 'rolled-back'), rel('c', 'ok')], 'c')?.sha).toBe('a')
    // Healthy again later: a target again.
    expect(lastGood([rel('a', 'ok'), rel('b', 'rollback-unhealthy'), rel('b', 'ok'), rel('c', 'ok')], 'c')?.sha).toBe('b')
    expect(lastGood([rel('b', 'ok'), rel('b', 'rollback-unhealthy')], 'c')).toBeUndefined()
  })
})

describe('rollback', () => {
  it('onto a release that does not answer: exit 1, recorded rollback-unhealthy, never picked again', async () => {
    let healthy = (_sha: string) => true
    const { host, head } = server({ healthyAt: (sha) => healthy(sha) })
    const ctx = context(host, config())
    expect(await run(ctx)).toBe(0)
    healthy = (sha) => sha === NEW
    expect(await rollback(ctx)).toBe(1)
    expect(head()).toBe(OLD)
    const releases = await readReleases(ctx)
    expect(releases.at(-1)).toMatchObject({ sha: OLD, status: 'rollback-unhealthy' })
    expect(releases.at(-1)?.note).toMatch(/aaaaaaa does not answer either/)
    expect(host.transcript).toContain('is recorded as rollback-unhealthy')
    expect(lastGood(releases, NEW)).toBeUndefined()
  })

  it('a deploy whose automatic rollback does not answer records both commits as unhealthy', async () => {
    const { host } = server({ healthyAt: () => false })
    const ctx = context(host, config())
    expect(await run(ctx)).toBe(1)
    expect((await readReleases(ctx)).map((r) => [r.sha, r.status])).toEqual([[NEW, 'rolled-back'], [OLD, 'rollback-unhealthy']])
  })

  it('refuses a checkout with local edits, before resetting anything', async () => {
    const { host, head } = server()
    const ctx = context(host, config())
    expect(await run(ctx)).toBe(0)
    host.handlers.unshift(({ command, args }) => (command === 'git' && args[0] === 'status' ? ok(' M src/app.ts\n') : undefined))
    await expect(rollback(ctx)).rejects.toThrow(/rollback: 1 problem/)
    expect(head()).toBe(NEW)
    expect(host.commands('git').some((c) => c.startsWith('git reset'))).toBe(false)
  })

  it('--to takes a commit sha only, and one this checkout has', async () => {
    const { host } = server()
    const ctx = context(host, config())
    await expect(rollback(ctx, '--upload-pack=x')).rejects.toThrow(/a commit sha/)
    await expect(rollback(ctx, 'HEAD~1')).rejects.toThrow(/a commit sha/)
    host.handlers.unshift(({ command, args }) => (command === 'git' && args.includes('--verify') ? { code: 1, stdout: '', stderr: '' } : undefined))
    await expect(rollback(ctx, 'deadbee')).rejects.toThrow(/not a commit in this checkout/)
    expect(host.commands('git')).toContain('git rev-parse --verify --quiet --end-of-options deadbee^{commit}')
  })

  it('holds the commit it left: the next run refuses it, --unhold deploys it, a healthy release clears the hold', async () => {
    const { host, head } = server()
    host.on(({ command }) => (command === 'pm2' ? ok(jlist()) : undefined))
    const ctx = context(host, config())
    expect(await run(ctx)).toBe(0)
    expect(await rollback(ctx)).toBe(0)
    expect(head()).toBe(OLD)
    expect(await readHold(ctx)).toMatchObject({ sha: NEW, actor: 'deployer', note: 'rolled back to aaaaaaa' })
    expect(host.transcript).toContain('bbbbbbb is held')

    const merges = () => host.commands('git').filter((c) => c.startsWith('git merge')).length
    const before = merges()
    await expect(run(ctx)).rejects.toThrow(/bbbbbbb is held: rolled back to aaaaaaa by deployer .* nothing was changed/)
    expect(merges()).toBe(before)
    expect(head()).toBe(OLD)

    await status(ctx)
    expect(host.transcript).toMatch(/held: bbbbbbb \(rolled back to aaaaaaa/)

    expect(await run(ctx, { unhold: true })).toBe(0)
    expect(head()).toBe(NEW)
    expect(await readHold(ctx)).toBeUndefined()
  })
})
