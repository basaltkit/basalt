import { describe, expect, it } from 'vitest'
import { createApp, ensureMetadata, type Container } from '@basaltkit/core'
import { isRouteVisible, route, type BasaltRoute } from '@basaltkit/http'
import { MemoryUserSource, apiKeysPlugin, authPlugin, type AuthPluginOptions } from '../src/index.js'
import { fastHasher } from './helpers/adapters.js'

/**
 * BK-061: side-effect-free visibility checks (used by MCP `tools/list`) for
 * `meta.scopes` (apiKeysPlugin) and `meta.mfa` (authPlugin). They mirror what
 * the guards read from ctx() and never touch a store or emit a hook.
 */

const secret = 'test-secret-test-secret-test-secret'

async function boot(extra: Partial<AuthPluginOptions> = {}) {
  const hooks: string[] = []
  const users = new MemoryUserSource()
  const app = await createApp({
    plugins: [authPlugin({ users, secret, hasher: fastHasher, ...extra }), apiKeysPlugin()],
  }).boot()
  app.hooks.onAny((name) => hooks.push(String(name)))
  return { container: app.container as Container, hooks, close: () => app.shutdown() }
}

const r = (meta: Record<string, unknown>): BasaltRoute =>
  route({ method: 'GET', url: '/x', meta: { mcp: true, ...meta }, handler: () => 'x' })

const key = (scopes: string[]) => ({ id: 'k1', scopes })
const user = { id: 'u1', email: 'u@example.com' }

describe('apiKeysPlugin visibility (meta.scopes)', () => {
  it('hides a scoped route from callers whose key does not cover every scope', async () => {
    const { container, hooks, close } = await boot()
    try {
      const scoped = r({ scopes: ['reports:read', 'reports:export'] })
      expect(await isRouteVisible(scoped, {}, container)).toBe(false) // no key at all
      expect(await isRouteVisible(scoped, { apiKey: key(['reports:read']) }, container)).toBe(false)
      expect(await isRouteVisible(scoped, { apiKey: key(['reports:read', 'reports:export']) }, container)).toBe(true)
      // Exactly like the guard: only the bare `*` is a wildcard.
      expect(await isRouteVisible(scoped, { apiKey: key(['reports:*']) }, container)).toBe(false)
      expect(await isRouteVisible(scoped, { apiKey: key(['*']) }, container)).toBe(true)
      // Routes without meta.scopes are not this check's business.
      expect(await isRouteVisible(r({}), {}, container)).toBe(true)
      expect(await isRouteVisible(r({ scopes: [] }), {}, container)).toBe(true)
      expect(hooks).toEqual([])
    } finally {
      await close()
    }
  })

  it('hides a key-refusing route (meta.apiKey: false) from a key holder only', async () => {
    const { container, close } = await boot()
    try {
      const sessionOnly = r({ apiKey: false })
      expect(await isRouteVisible(sessionOnly, { apiKey: key(['*']) }, container)).toBe(false)
      expect(await isRouteVisible(sessionOnly, { user }, container)).toBe(true)
    } finally {
      await close()
    }
  })
})

describe('authPlugin visibility (meta.mfa)', () => {
  it('hides meta.mfa: true from a user whose session has no second factor', async () => {
    const { container, hooks, close } = await boot()
    try {
      const stepUp = r({ auth: true, mfa: true })
      expect(await isRouteVisible(stepUp, { user, amr: ['pwd'] }, container)).toBe(false)
      expect(await isRouteVisible(stepUp, { user }, container)).toBe(false)
      expect(await isRouteVisible(stepUp, { user, amr: ['pwd', 'mfa'] }, container)).toBe(true)
      // Anonymous callers: meta.auth hides it (built in), not the MFA check.
      expect(await isRouteVisible(r({ mfa: true }), {}, container)).toBe(true)
      expect(hooks).toEqual([])
    } finally {
      await close()
    }
  })

  it('applies requireMfa: true like the guard (exempting meta.mfa: false and API keys)', async () => {
    const { container, close } = await boot({ requireMfa: true })
    try {
      expect(await isRouteVisible(r({ auth: true }), { user, amr: ['pwd'] }, container)).toBe(false)
      expect(await isRouteVisible(r({ auth: true }), { user, amr: ['pwd', 'mfa'] }, container)).toBe(true)
      expect(await isRouteVisible(r({ auth: true, mfa: false }), { user, amr: ['pwd'] }, container)).toBe(true)
      expect(await isRouteVisible(r({ auth: true, scopes: ['*'] }), { user, apiKey: key(['*']) }, container)).toBe(true)
    } finally {
      await close()
    }
  })

  it('never calls a requireMfa function policy on a listing (no purity contract) — the route stays listed', async () => {
    let calls = 0
    const { container, close } = await boot({
      requireMfa: () => {
        calls++
        return true
      },
    })
    try {
      expect(await isRouteVisible(r({ auth: true }), { user, amr: ['pwd'] }, container)).toBe(true)
      expect(calls).toBe(0)
    } finally {
      await close()
    }
  })

  it('registers exactly one check per plugin in the visibility bucket', async () => {
    const { container, close } = await boot()
    try {
      expect(ensureMetadata(container).get('http:route-visibility')).toHaveLength(2)
    } finally {
      await close()
    }
  })
})
