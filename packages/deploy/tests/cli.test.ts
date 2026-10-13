import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadConfig, main, UI_HINT } from '../src/cli.js'
import { detectPackageManager, resolveStateDir } from '../src/context.js'
import { FakeHost, jlist, ok } from './fake-host.js'

let dir: string
const CONFIG = `export default {
  app: 'acme', domain: 'acme.example.com', env: {},
  runtime: { kind: 'pm2', script: 'start', port: 'auto', avoid: [] },
}
`
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'basalt-deploy-cli-'))
  await writeFile(join(dir, 'deploy.config.mjs'), CONFIG)
  await writeFile(join(dir, 'named.mjs'), CONFIG.replace('export default', 'export const config ='))
  await writeFile(join(dir, 'empty.mjs'), 'export const nothing = 1\n')
  await writeFile(join(dir, 'invalid.mjs'), CONFIG.replace("app: 'acme'", "app: 'Lex Firma'"))
})
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

const stdout = () => vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

describe('loadConfig', () => {
  it('reads a default or a named `config` export', async () => {
    expect((await loadConfig(dir, 'deploy.config.mjs')).app).toBe('acme')
    expect((await loadConfig(dir, join(dir, 'named.mjs'))).app).toBe('acme')
  })

  it('says what is wrong with a file that is missing or exports nothing', async () => {
    await expect(loadConfig(dir, 'nope.mjs')).rejects.toThrow(/cannot load nope\.mjs/)
    await expect(loadConfig(dir, 'empty.mjs')).rejects.toThrow(/must export default defineDeploy/)
  })
})

describe('ui (RFC 0009 §3.4)', () => {
  it('only prints how to start the local UI, on stderr: no config, nothing spawned, exit 0; refused with --json', async () => {
    const host = new FakeHost()
    const errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const out = stdout()
    try {
      expect(await main(['ui', '--config=missing.mjs'], host, dir)).toBe(0)
      expect(errors.mock.calls.map((c) => String(c[0])).join('')).toBe(UI_HINT)
      expect(out).not.toHaveBeenCalled()
    } finally {
      errors.mockRestore()
      out.mockRestore()
    }
    expect(host.calls).toEqual([])
    expect(UI_HINT).toContain('npx @basaltkit/deploy-ui@<exact version>')
    expect(UI_HINT).toMatch(/never on the server/)
    expect(UI_HINT).toMatch(/not in the app's package\.json/)

    const lines: string[] = []
    const json = await main(['ui', '--json'], new FakeHost(), dir, { write: (t) => lines.push(t), stdin: async function* () {}, capture: () => () => undefined, stderr: () => undefined })
    expect(json).toBe(1)
    const events = lines.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; code?: string })
    expect(events.find((e) => e.type === 'error')).toMatchObject({ code: 'unsupported' })
  })
})

describe('main', () => {
  it('prints the usage for --help and for no command, and fails on an unknown one', async () => {
    const write = stdout()
    try {
      expect(await main(['--help'], new FakeHost(), dir)).toBe(0)
      expect(await main([], new FakeHost(), dir)).toBe(0)
      const host = new FakeHost()
      expect(await main(['deploy-everything', '--config=deploy.config.mjs'], host, dir)).toBe(1)
      expect(host.transcript).toContain('unknown command "deploy-everything"')
      expect(String(write.mock.calls[0]?.[0])).toContain('plan               what a run would do')
    } finally {
      write.mockRestore()
    }
  })

  it('only lets the safe steps be skipped', async () => {
    const host = new FakeHost()
    expect(await main(['run', '--skip=migrate'], host, dir)).toBe(1)
    expect(host.transcript).toContain('--skip=migrate: only fetch, backup, tls can be skipped')
  })

  it('reports an invalid config and stops', async () => {
    const host = new FakeHost()
    expect(await main(['status', '--config=invalid.mjs'], host, dir)).toBe(1)
    expect(host.transcript).toMatch(/app "Lex Firma" must match/)
  })

  it('applies the server overrides file and runs the command', async () => {
    const host = new FakeHost()
      .put('/etc/basalt/acme.json', '{"runtime": 1}')
      .on(({ command }) => (command === 'pm2' ? ok(jlist()) : undefined))
    expect(await main(['status', '--config=deploy.config.mjs'], host, dir)).toBe(1)
    expect(host.transcript).toContain('unknown keys runtime')

    host.put('/etc/basalt/acme.json', '{"branch": "main"}')
    expect(await main(['status', '--config=deploy.config.mjs'], host, dir)).toBe(0)
    expect(host.transcript).toContain('pm2 acme-api: not running')
  })

  it('turns a DeployError into exit 1 and an unexpected error into a one-line report', async () => {
    const refused = new FakeHost().on(({ command, args }) => (command === 'git' ? ok(args[0] === 'status' ? '' : `${'c'.repeat(40)}\n`) : undefined))
    expect(await main(['rollback', '--config=deploy.config.mjs'], refused, dir)).toBe(1)
    expect(refused.transcript).toContain('no earlier release to go back to')

    const broken = new FakeHost().on(() => { throw new Error('boom') })
    broken.env['BASALT_DEBUG'] = '1'
    expect(await main(['status', '--config=deploy.config.mjs'], broken, dir)).toBe(1)
    expect(broken.transcript).toContain('unexpected: boom')
  })
})

describe('context', () => {
  it('finds the package manager from packageManager, then the lockfile', async () => {
    const host = new FakeHost()
    expect(await detectPackageManager(host, '/app')).toBe('npm')
    host.put('/app/bun.lock', '')
    expect(await detectPackageManager(host, '/app')).toBe('bun')
    host.put('/app/yarn.lock', '')
    expect(await detectPackageManager(host, '/app')).toBe('yarn')
    host.put('/app/pnpm-lock.yaml', '')
    expect(await detectPackageManager(host, '/app')).toBe('pnpm')
    host.put('/app/package.json', '{"packageManager": "yarn@4.1.0"}')
    expect(await detectPackageManager(host, '/app')).toBe('yarn')
    host.put('/app/package.json', '{ not json')
    expect(await detectPackageManager(host, '/app')).toBe('pnpm')
  })

  it('keeps state in /var/lib/basalt/<app> once install created it, else in the checkout', async () => {
    const host = new FakeHost()
    const config = { app: 'acme' } as Parameters<typeof resolveStateDir>[1]
    expect(await resolveStateDir(host, config, '/app')).toBe('/app/.basalt')
    await host.mkdir('/var/lib/basalt/acme')
    expect(await resolveStateDir(host, config, '/app')).toBe('/var/lib/basalt/acme')
  })
})
