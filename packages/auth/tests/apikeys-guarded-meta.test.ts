import { describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
import { UnguardedRouteMetaError } from '@basaltkit/http'
import { fastifyPlugin, route } from '@basaltkit/fastify'
import { apiKeysPlugin, authPlugin, MemoryUserSource } from '../src/index.js'

/**
 * `meta.scopes` is an authorization request enforced by apiKeysPlugin's guard —
 * the same class as `meta.auth`/`meta.can`/`meta.teamRole`. It was missing from
 * the guarded-meta set, so a scope-gated route with apiKeysPlugin absent booted
 * and served without any scope check.
 */

const secret = 'test-secret-test-secret-test-secret'
const scoped = [
  route({ method: 'GET', url: '/ping', meta: { scopes: ['read'] }, handler: () => ({ ok: true }) }),
]

describe('meta.scopes is part of the guarded-meta boot check', () => {
  it('refuses to boot when a route declares scopes but apiKeysPlugin is absent', async () => {
    const error = await createApp({
      plugins: [
        authPlugin({ users: new MemoryUserSource(), secret, loginThrottle: false }),
        fastifyPlugin({ routes: scoped }),
      ],
    })
      .boot()
      .catch((e: unknown) => e as Error)
    expect(error).toBeInstanceOf(UnguardedRouteMetaError)
    expect((error as Error).message).toContain('meta.scopes')
    expect((error as Error).message).toContain('apiKeysPlugin')
  })

  it('boots when apiKeysPlugin is registered — it claims the key', async () => {
    const app = await createApp({
      plugins: [
        authPlugin({ users: new MemoryUserSource(), secret, loginThrottle: false }),
        apiKeysPlugin(),
        fastifyPlugin({ routes: scoped }),
      ],
    }).boot()
    expect(app).toBeDefined()
    await app.shutdown()
  })
})
