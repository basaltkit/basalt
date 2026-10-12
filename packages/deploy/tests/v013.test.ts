/**
 * The Acme deploys blocked by their own dirty check (2026-10-11): pnpm 12
 * rewrote pnpm-lock.yaml (packageManagerDependencies) on `pnpm --version` in
 * preflight, and on `pnpm exec`/`run` during the build of the deploy before.
 */
import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { toolingFindings } from '../src/checks.js'
import { dockerInfra } from '../src/config.js'
import { preflight, run } from '../src/pipeline.js'
import { context, DIR, FakeHost, jlist, acmeConfig, ok } from './fake-host.js'

const ENV = 'NODE_ENV=production\nHOST=127.0.0.1\nPORT=3002\nAPP_SECRET=x\nMAILER_URL=\nPAYCO_SECRET_TOKEN=t\nPAYCO_CALLBACK_URL=https://acme.example.com/api/webhooks/payco\n'

/** A server whose pnpm rewrites the lockfile whenever it runs inside the checkout. */
function server(options: { dirtyAtStart?: string; rewriteOn?: (args: string[]) => boolean } = {}) {
  let lockDirty = Boolean(options.dirtyAtStart)
  let other = options.dirtyAtStart && options.dirtyAtStart !== 'lock' ? options.dirtyAtStart : ''
  const host = new FakeHost().put(`${DIR}/.env`, ENV, 0o600).put(`${DIR}/package.json`, '{"packageManager":"pnpm@12.3.4"}')
  host
    .on(({ command, args, options: o }) => {
      if (command !== 'pnpm') return undefined
      if (o.cwd === DIR && (options.rewriteOn ?? (() => true))(args)) lockDirty = true
      return args[0] === '--version' ? ok('12.3.4\n') : ok()
    })
    .on(({ command, args }) => {
      if (command !== 'git') return undefined
      if (args[0] === 'status') {
        const lines = [lockDirty ? ' M pnpm-lock.yaml' : '', other ? ` M ${other}` : ''].filter(Boolean)
        return ok(lines.join('\n'))
      }
      if (args[0] === 'checkout' && args.includes('pnpm-lock.yaml')) { lockDirty = false; return ok() }
      if (args[0] === 'rev-parse') return ok(args[1] === '--abbrev-ref' ? 'master\n' : `${'a'.repeat(40)}\n`)
      if (args[0] === 'ls-remote') return ok('x')
      return ok()
    })
    .on(({ command }) => (command === 'node' ? ok('v24.17.0') : undefined))
    .on(({ command }) => (command === 'ss' ? ok('') : undefined))
    .on(({ command, args }) => (command === 'pm2' && args[0] === 'jlist' ? ok(jlist({ name: 'acme-api', cwd: DIR })) : undefined))
    .on(({ command }) => (command === 'pm2' ? ok() : undefined))
    .on(({ command }) => (command === process.execPath ? ok('\n@@basalt-deploy@@{"ok":true,"trueKeys":[]}\n') : undefined))
  return { host, lockDirty: () => lockDirty, clean: () => { other = '' } }
}

const config = () => acmeConfig({ proxy: { kind: 'none' }, backup: { beforeMigrate: false } })

describe('a check never changes the repository it checks', () => {
  it('the version probes run outside the checkout', async () => {
    const { host } = server()
    await toolingFindings(context(host, acmeConfig({ infra: dockerInfra('acme') })))
    const probes = host.calls.filter((c) => c.args[0] === '--version' || (c.command === 'docker' && c.args[1] === 'version'))
    expect(probes.map((c) => c.options.cwd)).toEqual([tmpdir(), tmpdir(), tmpdir()])
  })

  it('preflight leaves a clean checkout clean, and looks at git before running anything else', async () => {
    const { host, lockDirty } = server()
    const { findings } = await preflight(context(host, config()), { skip: ['tls'] })
    expect(findings.filter((f) => f.id === 'git')).toEqual([])
    expect(lockDirty()).toBe(false)
    expect(host.calls[0]).toMatchObject({ command: 'git', args: ['status', '--porcelain', '--untracked-files=no'] })
  })
})

describe('a lockfile pnpm rewrote', () => {
  it('found modified at the start: says it was most likely pnpm, and how to get out', async () => {
    const { host } = server({ dirtyAtStart: 'lock' })
    const { findings } = await preflight(context(host, config()), { skip: ['tls'] })
    expect(findings.find((f) => f.id === 'git')?.fix).toMatch(/^only the lockfile — most likely rewritten by the package manager.*git checkout -- pnpm-lock\.yaml/)
  })

  it('any other modified file keeps the general advice', async () => {
    const { host } = server({ dirtyAtStart: 'src/app.ts' })
    const { findings } = await preflight(context(host, config()), { skip: ['tls'] })
    expect(findings.find((f) => f.id === 'git')?.fix).toBe('git stash (or commit them where they belong); a deploy builds what is committed')
  })

  it('rewritten during the build: put back before the release, with a warning — the next deploy is not blocked', async () => {
    const { host, lockDirty } = server({ rewriteOn: (args) => args[0] === 'exec' })
    expect(await run(context(host, config()), { skip: ['tls'] })).toBe(0)
    expect(lockDirty()).toBe(false)
    expect(host.commands('git')).toContain('git checkout -- pnpm-lock.yaml')
    // Rewritten by both `exec` steps (prisma generate, migrate deploy), said once.
    expect(host.transcript.match(/\[C11\] pnpm rewrote/g)).toHaveLength(1)
    expect(host.transcript).toContain('[C11] pnpm rewrote pnpm-lock.yaml during the deploy; put back to the committed version')
    // The next deploy starts from a clean tree.
    const next = await preflight(context(host, config()), { skip: ['tls'] })
    expect(next.findings.filter((f) => f.id === 'git')).toEqual([])
  })

  it('nothing to put back when pnpm left it alone', async () => {
    const { host } = server({ rewriteOn: () => false })
    expect(await run(context(host, config()), { skip: ['tls'] })).toBe(0)
    expect(host.commands('git').some((c) => c.startsWith('git checkout --'))).toBe(false)
    expect(host.transcript).not.toContain('rewrote')
  })
})
