import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { envModeFindings } from '../src/env-step.js'
import { nodeHost, type Output } from '../src/host.js'
import { envCommand, preflight, run } from '../src/pipeline.js'
import { acmeConfig, context } from './fake-host.js'
import { ENV, GOOD_ENV, server } from './acme-server.js'

const config = () => acmeConfig({ backup: { beforeMigrate: false } })

describe('the .env mode and owner', () => {
  it('preflight reports a .env other users can read; run puts it back to 0600', async () => {
    const { host } = server()
    host.put(ENV, GOOD_ENV, 0o644)
    const ctx = context(host, config())
    const checked = await preflight(ctx, { skip: ['tls'] })
    expect(checked.findings).toContainEqual(expect.objectContaining({ id: 'env-mode', level: 'warning', message: `${ENV} is 644: its secrets are readable by other users of this server` }))
    expect(await run(ctx)).toBe(0)
    expect(host.mode(ENV)).toBe(0o600)
    expect(host.transcript).toContain(`${ENV} is 0600 again`)
  })

  it('env fixes the mode even when nothing in the file changes', async () => {
    const { host } = server()
    host.put(ENV, GOOD_ENV, 0o640)
    expect(await envCommand(context(host, config()))).toBe(0)
    expect(host.mode(ENV)).toBe(0o600)
  })

  it('a .env owned by someone else is reported, never chmod-ed', async () => {
    const { host } = server()
    host.put(ENV, GOOD_ENV, 0o644, { uid: 0 })
    const ctx = context(host, config())
    expect(await envModeFindings(ctx)).toEqual([expect.objectContaining({ id: 'env-owner', message: `${ENV} is owned by uid 0, not by the deploy user (uid 1000)` })])
    expect(await envCommand(ctx)).toBe(0)
    expect(host.mode(ENV)).toBe(0o644)
  })

  describe('on the real host', () => {
    const quiet: Output = { step() {}, info() {}, ok() {}, warn() {}, error() {} }
    let dir: string
    beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'basalt-deploy-mode-')) })
    afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

    it('reads the mode and owner, and chmods', async () => {
      const file = join(dir, '.env')
      await writeFile(file, 'A=1\n')
      await chmod(file, 0o644)
      const host = nodeHost(quiet)
      const ctx = { ...context(host as never, acmeConfig()), host, dir }
      expect((await envModeFindings(ctx)).map((f) => f.id)).toEqual(['env-mode'])
      await host.chmod(file, 0o600)
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      expect(await envModeFindings(ctx)).toEqual([])
    })
  })
})
