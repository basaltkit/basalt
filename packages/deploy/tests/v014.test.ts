/**
 * What the first `install` on the LexFirma server showed (2026-10-11):
 * `sudo node …` → "sudo: node: command not found" (Node installed per user,
 * by nvm), a closing hint that said `pnpm exec` (the form that rewrote the
 * lockfile), and a state-directory step that printed nothing.
 */
import { describe, expect, it } from 'vitest'
import { INSTALL_COMMAND, RUN_COMMAND } from '../src/context.js'
import { USAGE } from '../src/cli.js'
import { install } from '../src/pipeline.js'
import { context, DIR, FakeHost, lexfirmaConfig, ok } from './fake-host.js'

const rootHost = () => {
  const host = new FakeHost().put(`${DIR}/.env`, 'PORT=3002\n', 0o600)
  host.userId = 0
  return host.on(({ command }) => (['chown', 'a2enmod', 'apachectl', 'systemctl', 'id'].includes(command) ? ok('ubuntu') : undefined))
}

describe('commands that work on a server with a per-user Node', () => {
  it('install resolves node in the operator\'s shell, before sudo', () => {
    expect(INSTALL_COMMAND).toBe('sudo "$(command -v node)" node_modules/@basaltkit/deploy/dist/bin.js install --user="$USER"')
    expect(USAGE).toContain('sudo "$(command -v node)" node_modules/@basaltkit/deploy/dist/bin.js install')
  })

  it('no hint ever says `pnpm exec basalt-deploy`', async () => {
    expect(RUN_COMMAND).toBe('node node_modules/@basaltkit/deploy/dist/bin.js run')
    const host = rootHost()
    await install(context(host, lexfirmaConfig({ proxy: { kind: 'none' } })), 'ubuntu')
    expect(host.transcript).toContain(`installed — from now on, as ubuntu (not root), in ${DIR}: node node_modules/@basaltkit/deploy/dist/bin.js run`)
    expect(host.transcript).not.toContain('pnpm exec')
  })

  it('without a PORT, points at `env` the same way', async () => {
    const host = rootHost().put(`${DIR}/.env`, '')
    await expect(install(context(host), 'ubuntu')).rejects.toThrow('run `node node_modules/@basaltkit/deploy/dist/bin.js env` as the app user first')
  })
})

describe('the state-directory step says what it did', () => {
  it('created, owned by the app user, and how many releases it copied', async () => {
    const host = rootHost().put(`${DIR}/.basalt/releases.json`, JSON.stringify([{ sha: 'a' }, { sha: 'b' }]))
    await install(context(host, lexfirmaConfig({ proxy: { kind: 'none' } })), 'ubuntu')
    expect(host.transcript).toContain(`OK /var/lib/basalt/lexfirma (0700, owned by ubuntu); 2 release(s) copied from ${DIR}/.basalt/releases.json`)
    expect(host.transcript).toContain('OK /etc/basalt/lexfirma.json created (server-local overrides, no secrets)')
  })

  it('a second install keeps the history and does not recreate the overrides', async () => {
    const host = rootHost()
      .put('/var/lib/basalt/lexfirma/releases.json', '[]')
      .put('/etc/basalt/lexfirma.json', '{"port":3002}')
    await install(context(host, lexfirmaConfig({ proxy: { kind: 'none' } })), 'ubuntu')
    expect(host.transcript).toContain('release history kept as it was')
    expect(host.transcript).not.toContain('/etc/basalt/lexfirma.json created')
    expect(host.file('/etc/basalt/lexfirma.json')).toBe('{"port":3002}')
  })

  it('a first install with no history says so', async () => {
    const host = rootHost()
    await install(context(host, lexfirmaConfig({ proxy: { kind: 'none' } })), 'ubuntu')
    expect(host.transcript).toContain('; no release history yet')
  })
})
