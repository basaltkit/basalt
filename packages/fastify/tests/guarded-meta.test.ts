import { describe, expect, it } from 'vitest'
import { createApp, definePlugin, ensureMetadata } from '@basaltkit/core'
import { GUARDED_META_BUCKET, UnguardedRouteMetaError, route } from '@basaltkit/http'
import { fastifyPlugin } from '../src/index.js'

const protectedRoute = route({
  method: 'GET',
  url: '/me',
  meta: { auth: true },
  handler: async () => ({ ok: true }),
})

/** Simulates authPlugin's claim without pulling @basaltkit/auth in. */
const claimingPlugin = definePlugin({
  name: 'fake-auth-claim',
  register({ container }) {
    ensureMetadata(container).add(GUARDED_META_BUCKET, 'auth')
  },
})

describe('fastify: boot fails loud when security meta has no enforcing guard', () => {
  it('meta.auth with no enforcing plugin → boot rejects (fail closed, before traffic)', async () => {
    await expect(
      createApp({ plugins: [fastifyPlugin({ routes: [protectedRoute] })] }).boot(),
    ).rejects.toBeInstanceOf(UnguardedRouteMetaError)
  })

  it('boots when the enforcing plugin claimed the key', async () => {
    const app = await createApp({ plugins: [claimingPlugin, fastifyPlugin({ routes: [protectedRoute] })] }).boot()
    await app.shutdown()
  })

  it('allowUnguardedMeta waives the check for edge-auth deployments', async () => {
    const app = await createApp({
      plugins: [fastifyPlugin({ routes: [protectedRoute], allowUnguardedMeta: ['auth'] })],
    }).boot()
    await app.shutdown()
  })
})
