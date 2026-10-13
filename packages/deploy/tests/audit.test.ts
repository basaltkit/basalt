import { describe, expect, it } from 'vitest'
import { auditOf } from '../src/audit.js'
import { rollback, run } from '../src/pipeline.js'
import { readReleases } from '../src/state.js'
import { acmeConfig, context, FakeHost, ok } from './fake-host.js'
import { server } from './acme-server.js'

describe('audit fields', () => {
  it('actor from --actor, else $BASALT_DEPLOY_ACTOR, else $USER; client and via from the session', () => {
    const host = new FakeHost()
    expect(auditOf(host)).toEqual({ actor: 'deployer', via: 'batch' })
    host.env['BASALT_DEPLOY_ACTOR'] = 'alice'
    host.env['SSH_CONNECTION'] = '192.0.2.10 50022 192.0.2.1 22'
    expect(auditOf(host)).toEqual({ actor: 'alice', client: '192.0.2.10', via: 'ssh' })
    expect(auditOf(host, 'bob@example.com').actor).toBe('bob@example.com')
    host.env['SSH_CONNECTION'] = '$(touch x) 1 2 3'
    expect(auditOf(host).client).toBeUndefined()
    delete host.env['SSH_CONNECTION']
    host.env['CI'] = '1'
    expect(auditOf(host).via).toBe('ci')
    expect(() => auditOf(host, 'a b')).toThrow(/--actor "a b"/)
  })

  it('every release record carries them, and status prints who and from where', async () => {
    const { host } = server()
    host.env['SSH_CONNECTION'] = '192.0.2.10 50022 192.0.2.1 22'
    const ctx = context(host, acmeConfig({ backup: { beforeMigrate: false } }))
    expect(await run(ctx, { actor: 'alice' })).toBe(0)
    expect(await rollback(ctx, undefined, { actor: 'bob' })).toBe(0)
    const releases = await readReleases(ctx)
    expect(releases.map((r) => [r.actor, r.user, r.client, r.via])).toEqual([
      ['alice', 'deployer', '192.0.2.10', 'ssh'],
      ['bob', 'deployer', '192.0.2.10', 'ssh'],
    ])
    expect(ctx.audit).toBeUndefined()
  })

  it('audit.syslog sends one line per release to logger; a logger failure is a warning', async () => {
    const { host } = server()
    host.on(({ command }) => (command === 'logger' ? ok() : undefined))
    const ctx = context(host, acmeConfig({ backup: { beforeMigrate: false }, audit: { syslog: true } }))
    expect(await run(ctx, { actor: 'alice' })).toBe(0)
    expect(host.commands('logger')).toEqual([`logger -t basalt-deploy -- app=acme sha=${'b'.repeat(12)} status=ok actor=alice via=batch`])

    const quiet = server()
    quiet.host.on(({ command }) => (command === 'logger' ? { code: 1, stdout: '', stderr: 'no syslog' } : undefined))
    expect(await run(context(quiet.host, acmeConfig({ backup: { beforeMigrate: false }, audit: { syslog: true } })))).toBe(0)
    expect(quiet.host.transcript).toContain('audit.syslog: logger failed (no syslog)')
  })
})
