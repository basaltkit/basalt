import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DeployContext } from '../src/context.js'
import { nodeHost, type Output } from '../src/host.js'
import { pm2 } from '../src/config.js'
import { pm2Release } from '../src/pm2.js'
import { acmeConfig } from './fake-host.js'

// The merge gate for the env.file preload, against REAL pm2: the app gets the
// values, pm2 never holds them — not in its daemon, not in `pm2 save`'s dump,
// through restart --update-env and resurrect. CI sets BASALT_PM2_IT=1 (and
// installs pm2), which makes a missing pm2 a failure instead of a skip.
const required = process.env['BASALT_PM2_IT'] === '1'
const hasPm2 = spawnSync('pm2', ['--version'], { encoding: 'utf8' }).status === 0
if (required && !hasPm2) throw new Error('BASALT_PM2_IT=1 but pm2 is not on PATH')

const quiet: Output = { step() {}, info() {}, ok() {}, warn() {}, error() {} }

describe.skipIf(!hasPm2)('pm2 runtime with real pm2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'basalt-pm2-app-'))
  const home = mkdtempSync(join(tmpdir(), 'basalt-pm2-home-'))
  const seen = join(dir, 'seen.json')
  const savedHome = process.env['PM2_HOME']
  let ctx: DeployContext

  const pm2Cli = (...args: string[]) => spawnSync('pm2', args, { env: { ...process.env, PM2_HOME: home }, encoding: 'utf8' })
  const writeEnv = (secret: string) => writeFileSync(join(dir, '.env'), `SECRET=${secret}\nNODE_ENV=development\n`, { mode: 0o600 })

  async function waitForSecret(secret: string): Promise<{ secret: string; nodeEnv: string }> {
    for (let i = 0; i < 100; i += 1) {
      if (existsSync(seen)) {
        const value = JSON.parse(readFileSync(seen, 'utf8')) as { secret: string; nodeEnv: string }
        if (value.secret === secret) return value
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`the app never saw ${secret}; pm2 logs:\n${pm2Cli('logs', '--nostream', '--lines', '40').stdout}`)
  }

  /** The daemon's environment, where the OS shows it (Linux /proc; macOS ps eww). */
  function daemonEnv(): string {
    const pid = readFileSync(join(home, 'pm2.pid'), 'utf8').trim()
    if (existsSync(`/proc/${pid}/environ`)) return readFileSync(`/proc/${pid}/environ`, 'utf8')
    return spawnSync('ps', ['eww', '-p', pid], { encoding: 'utf8' }).stdout
  }

  const canaryFor = (n: number) => `canary-${n}-${'x'.repeat(24)}`

  beforeAll(() => {
    process.env['PM2_HOME'] = home
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'acme', private: true, scripts: { start: 'node server.js' } }))
    writeFileSync(join(dir, 'server.js'), [
      `require('node:fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ secret: process.env.SECRET ?? null, nodeEnv: process.env.NODE_ENV ?? null }))`,
      'setInterval(() => {}, 1 << 30)',
    ].join('\n'))
    ctx = {
      config: acmeConfig({ runtime: pm2({ port: 3999 }) }),
      dir, host: nodeHost(quiet), pm: 'npm', envPath: join(dir, '.env'), stateDir: join(dir, '.basalt'),
    }
  })

  afterAll(() => {
    pm2Cli('kill')
    if (savedHome === undefined) delete process.env['PM2_HOME']
    else process.env['PM2_HOME'] = savedHome
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  const release = () => pm2Release(ctx, new Map([['NODE_ENV', 'production'], ['PORT', '3999']]))

  it('start: the app sees the env.file, pm2 exports win, and neither the dump nor the daemon holds the secret', async () => {
    writeEnv(canaryFor(1))
    await release()
    expect(await waitForSecret(canaryFor(1))).toEqual({ secret: canaryFor(1), nodeEnv: 'production' })
    const dump = readFileSync(join(home, 'dump.pm2'), 'utf8')
    expect(dump).toContain(join(dir, '.env')) // the path is what pm2 keeps…
    expect(dump).not.toContain('canary-') // …never the value
    expect(daemonEnv()).not.toContain('canary-')
  })

  it('restart --update-env picks up a rotated value, still without persisting it', async () => {
    writeEnv(canaryFor(2))
    await release()
    await waitForSecret(canaryFor(2))
    expect(readFileSync(join(home, 'dump.pm2'), 'utf8')).not.toContain('canary-')
    expect(daemonEnv()).not.toContain('canary-')
  })

  it('resurrect after a reboot (pm2 kill) reads the file again', async () => {
    writeEnv(canaryFor(3))
    expect(pm2Cli('kill').status).toBe(0)
    expect(pm2Cli('resurrect').status).toBe(0)
    await waitForSecret(canaryFor(3))
    expect(daemonEnv()).not.toContain('canary-')
  })
})
