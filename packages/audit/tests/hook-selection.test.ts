import { describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
import { AUDIT, auditPlugin, DEFAULT_AUDIT_HOOK_EXCLUDES, type AuditPluginOptions } from '../src/index.js'

/**
 * BK-083 (d): `auth:apikey_rejected` fires for every request presenting a key
 * that does not verify, before anyone is authenticated. Captured by the default
 * `auth:**`, it let any anonymous client append to the audit trail at will.
 */
const boot = async (options: AuditPluginOptions = {}) => {
  const app = await createApp({ plugins: [auditPlugin({ events: [], ...options })] }).boot()
  return { app, audit: app.container.get(AUDIT) }
}

type App = Awaited<ReturnType<typeof boot>>['app']
type AuditService = Awaited<ReturnType<typeof boot>>['audit']

// The hook's typed payload lives in @basaltkit/auth's module augmentation;
// audit does not depend on auth, so the emit goes through an untyped view.
const emit = (app: App, hook: string, payload: unknown) =>
  (app.hooks as unknown as { emit(hook: string, payload: unknown): Promise<void> }).emit(hook, payload)

const flood = async (app: App, times: number) => {
  for (let i = 0; i < times; i++) {
    await emit(app, 'auth:apikey_rejected', { reason: 'invalid', prefix: 'mk_live_abcdef', ip: '203.0.113.9' })
  }
}

// Sorted: the assertions are about which hooks were captured, not trail order.
const events = async (audit: AuditService) => (await audit.systemTrail()).map((e) => e.event).sort()

describe('auditPlugin hook selection (BK-083)', () => {
  it('excludes auth:apikey_rejected by default: 100 rejected keys write nothing', async () => {
    const { app, audit } = await boot()
    await flood(app, 100)
    await emit(app, 'auth:login', { user: { id: 'u1' } })
    expect(await events(audit)).toEqual(['auth:login'])
    expect(DEFAULT_AUDIT_HOOK_EXCLUDES).toContain('auth:apikey_rejected')
  })

  it('a plain list keeps the default excludes', async () => {
    const { app, audit } = await boot({ hooks: ['auth:**'] })
    await flood(app, 3)
    await emit(app, 'auth:logout', { userId: 'u1' })
    expect(await events(audit)).toEqual(['auth:logout'])
  })

  it('naming the hook exactly in the list opts it back in', async () => {
    const { app, audit } = await boot({ hooks: ['auth:**', 'auth:apikey_rejected'] })
    await flood(app, 2)
    expect(await events(audit)).toEqual(['auth:apikey_rejected', 'auth:apikey_rejected'])
  })

  it('the object form: explicit include records it, a custom exclude drops others', async () => {
    const { app, audit } = await boot({ hooks: { include: ['auth:**', 'auth:apikey_rejected'], exclude: ['auth:logout'] } })
    await flood(app, 1)
    await emit(app, 'auth:logout', { userId: 'u1' })
    await emit(app, 'auth:login', { user: { id: 'u1' } })
    expect(await events(audit)).toEqual(['auth:apikey_rejected', 'auth:login'])
  })

  it('exclude: [] turns the default excludes off', async () => {
    const { app, audit } = await boot({ hooks: { include: ['auth:**'], exclude: [] } })
    await flood(app, 1)
    expect(await events(audit)).toEqual(['auth:apikey_rejected'])
  })

  it('a wildcard exclude beats a wildcard include', async () => {
    const { app, audit } = await boot({ hooks: { include: ['auth:**', 'billing:**'], exclude: ['billing:**'] } })
    await emit(app, 'billing:subscribed', {})
    await emit(app, 'auth:login', { user: { id: 'u1' } })
    expect(await events(audit)).toEqual(['auth:login'])
  })
})
