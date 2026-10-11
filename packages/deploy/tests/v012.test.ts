/**
 * C11 — the two failed LexFirma deploys of 2026-10-11: `packageManager:
 * pnpm@12.3.4` committed with a lockfile written by pnpm 11, so the server's
 * pnpm 12 refused `--frozen-lockfile` half-way through the build.
 */
import { describe, expect, it } from 'vitest'
import { lockedPnpm, lockfileFindings } from '../src/checks.js'
import { run } from '../src/pipeline.js'
import { context, DIR, FakeHost, jlist, lexfirmaConfig, ok } from './fake-host.js'

// The section pnpm 12 writes, as it landed in the LexFirma lockfile.
const SECTION = `---
lockfileVersion: '9.0'

importers:

  .:
    configDependencies: {}
    packageManagerDependencies:
      '@pnpm/exe':
        specifier: 12.3.4
        version: 12.3.4
      pnpm:
        specifier: 12.3.4
        version: 12.3.4

packages:

  pnpm@12.3.4:
    resolution: {integrity: sha512-x}
---
`
const BODY = "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    devDependencies: {}\n"
const pkg = (packageManager?: string) => JSON.stringify(packageManager ? { packageManager } : {})

const host = (packageManager: string | undefined, lockfile: string | undefined) => {
  const h = new FakeHost().put(`${DIR}/package.json`, pkg(packageManager))
  if (lockfile !== undefined) h.put(`${DIR}/pnpm-lock.yaml`, lockfile)
  return h
}

describe('lockedPnpm', () => {
  it('reads the pnpm version the lockfile records', () => {
    expect(lockedPnpm(SECTION + BODY)).toBe('12.3.4')
    expect(lockedPnpm(BODY)).toBeUndefined()
  })
})

describe('C11 — packageManager the lockfile does not record', () => {
  it('pnpm@12 with a lockfile written by pnpm 11 is an error (the incident)', async () => {
    const findings = await lockfileFindings(context(host('pnpm@12.3.4', BODY)))
    expect(findings).toEqual([expect.objectContaining({
      id: 'C11', level: 'error',
      message: expect.stringContaining('does not record it'),
      fix: 'run pnpm install --lockfile-only with pnpm 12.3.4 and commit pnpm-lock.yaml',
    })])
  })

  it('a recorded version that differs from the declared one is an error', async () => {
    const findings = await lockfileFindings(context(host('pnpm@12.3.5', SECTION + BODY)))
    expect(findings[0]?.message).toContain('records pnpm 12.3.4')
  })

  it('stays quiet when they agree, when nothing is declared, below pnpm 12, or for another manager', async () => {
    expect(await lockfileFindings(context(host('pnpm@12.3.4', SECTION + BODY)))).toEqual([])
    expect(await lockfileFindings(context(host(undefined, BODY)))).toEqual([])
    expect(await lockfileFindings(context(host('pnpm@11.8.0', BODY)))).toEqual([])
    expect(await lockfileFindings(context(host('pnpm@12.3.4', undefined)))).toEqual([])
    expect(await lockfileFindings(context(host('pnpm@12.3.4+sha512.abc', SECTION + BODY)))).toEqual([])
    expect(await lockfileFindings({ ...context(host('pnpm@12.3.4', BODY)), pm: 'npm' })).toEqual([])
    expect(await lockfileFindings(context(host('pnpm@12.3.4', BODY).put(`${DIR}/package.json`, '{')))).toEqual([])
  })

  it('checks the commit the fetch brings, and puts the old one back before any install', async () => {
    let head = 'a'.repeat(40)
    const h = host(undefined, BODY)
      .put(`${DIR}/.env`, 'NODE_ENV=production\nHOST=127.0.0.1\nPORT=3002\nAPP_SECRET=x\nMAILER_URL=\nPROXYPAY_SECRET_TOKEN=t\nPROXYPAY_CALLBACK_URL=https://lexfirma.aipro.ao/api/webhooks/proxypay\n', 0o600)
      .on(({ command, args }) => {
        if (command !== 'git') return undefined
        if (args[0] === 'status') return ok('')
        if (args[0] === 'rev-parse') return ok(args[1] === '--abbrev-ref' ? 'master\n' : `${head}\n`)
        if (args[0] === 'merge') {
          // The incoming commit: packageManager pinned, lockfile not regenerated.
          head = 'b'.repeat(40)
          h.put(`${DIR}/package.json`, pkg('pnpm@12.3.4'))
          return ok()
        }
        if (args[0] === 'reset') {
          head = args[2] as string
          h.put(`${DIR}/package.json`, pkg())
          return ok()
        }
        return ok()
      })
      .on(({ command }) => (command === 'ss' ? ok('') : undefined))
      .on(({ command, args }) => (command === 'pm2' && args[0] === 'jlist' ? ok(jlist({ name: 'lexfirma-api', cwd: DIR })) : undefined))
      .on(({ command }) => (command === 'node' || command === 'pnpm' ? ok('12.3.4') : undefined))

    const ctx = context(h, lexfirmaConfig({ proxy: { kind: 'none' }, backup: { beforeMigrate: false } }))
    await expect(run(ctx, { skip: ['tls'] })).rejects.toThrow(/the incoming commit bbbbbbb/)
    expect(h.transcript).toContain('[C11] package.json declares pnpm@12.3.4')
    expect(head).toBe('a'.repeat(40))
    // Stopped before the install that used to fail half-way; the restore rebuilds the old commit.
    const installs = h.calls.filter((c) => c.command === 'pnpm' && c.args[0] === 'install')
    expect(installs).toHaveLength(1)
    expect(h.calls.indexOf(installs[0]!)).toBeGreaterThan(h.calls.findIndex((c) => c.args[0] === 'reset'))
  })
})
