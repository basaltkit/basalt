import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { main } from '../src/cli.js'
import { envCommand, rollback, run } from '../src/pipeline.js'
import { acmeConfig, context, FakeHost, jlist, ok } from './fake-host.js'
import { server } from './acme-server.js'

describe('uid 0', () => {
  it('run, env and rollback refuse root before taking the lock or running anything', async () => {
    const { host } = server()
    host.userId = 0
    const ctx = context(host, acmeConfig({ backup: { beforeMigrate: false } }))
    for (const command of [() => run(ctx), () => envCommand(ctx), () => rollback(ctx)]) {
      await expect(command()).rejects.toThrow(/runs as the app user, not root/)
    }
    expect(host.calls).toEqual([])
    expect([...host.files.keys()].some((p) => p.endsWith('deploy.lock'))).toBe(false)
  })

  it('--allow-root runs anyway', async () => {
    const { host } = server()
    host.userId = 0
    expect(await run(context(host, acmeConfig({ backup: { beforeMigrate: false } })), { allowRoot: true })).toBe(0)
  })

  describe('the CLI never loads deploy.config.ts as root', () => {
    let dir: string
    let marker: string
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'basalt-deploy-root-'))
      marker = join(dir, 'config-code-ran')
      // A config the app user controls: importing it runs this code.
      await writeFile(join(dir, 'deploy.config.mjs'), `import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(marker)}, 'ran')
export default { app: 'acme', domain: 'acme.example.com', env: {}, runtime: { kind: 'pm2', script: 'start', port: 3002, avoid: [] } }
`)
    })
    afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

    it('refuses every config-loading command as root, without importing it', async () => {
      for (const command of ['check', 'plan', 'run', 'env', 'rollback', 'status', 'init']) {
        const host = new FakeHost()
        host.userId = 0
        expect(await main([command, '--config=deploy.config.mjs'], host, dir), command).toBe(1)
        expect(host.transcript).toContain('runs as the app user, not root')
      }
      expect(existsSync(marker)).toBe(false)
    })

    it('loads it with --allow-root, deliberately', async () => {
      const host = new FakeHost().on(({ command }) => (command === 'pm2' ? ok(jlist()) : undefined))
      host.userId = 0
      expect(await main(['status', '--config=deploy.config.mjs', '--allow-root'], host, dir)).toBe(0)
      expect(existsSync(marker)).toBe(true)
    })
  })
})
