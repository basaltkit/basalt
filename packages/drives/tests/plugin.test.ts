import { describe, expect, it } from 'vitest'
import { createApp, definePlugin, ensureMetadata } from '@basaltkit/core'
import { DRIVES, drivesPlugin } from '../src/plugin.js'
import { Drives } from '../src/drives.js'
import { DriveTenantRequiredError } from '../src/errors.js'
import { FakeDriveProvider } from '../src/testing.js'
import { TEST_KEYS, TEST_SECRET } from './helpers.js'

/** Stands in for `tenancyPlugin`, which sets exactly this marker. */
const fakeTenancyPlugin = () =>
  definePlugin({
    name: 'fake:tenancy',
    register({ container }) {
      ensureMetadata(container).add('tenancy:active', true)
    },
  })

const options = () => ({ providers: [new FakeDriveProvider()], keys: TEST_KEYS, secret: TEST_SECRET })

describe('drivesPlugin', () => {
  it('registers Drives in the container', async () => {
    const app = createApp({ plugins: [drivesPlugin(options())] })
    await app.boot()
    expect(app.container.get(DRIVES)).toBeInstanceOf(Drives)
    await app.shutdown()
  })

  it('is single-tenant when tenancy is not registered', async () => {
    const app = createApp({ plugins: [drivesPlugin(options())] })
    await app.boot()
    await expect(app.container.get(DRIVES).list()).resolves.toEqual([])
    await app.shutdown()
  })

  it('enforces tenant scoping when tenancy is registered', async () => {
    const app = createApp({ plugins: [fakeTenancyPlugin(), drivesPlugin(options())] })
    await app.boot()
    await expect(app.container.get(DRIVES).list()).rejects.toThrow(DriveTenantRequiredError)
    await app.shutdown()
  })

  it('does not depend on plugin registration order', async () => {
    // The marker is read per call, not captured at registration: otherwise
    // whether tenant isolation is enforced would depend on plugin order, which
    // is exactly the kind of silent fail-open this framework avoids.
    const app = createApp({ plugins: [drivesPlugin(options()), fakeTenancyPlugin()] })
    await app.boot()
    await expect(app.container.get(DRIVES).list()).rejects.toThrow(DriveTenantRequiredError)
    await app.shutdown()
  })

  it('emits its hooks on the app hook bus', async () => {
    const app = createApp({ plugins: [drivesPlugin(options())] })
    await app.boot()
    const seen: string[] = []
    app.hooks.onAny((hook) => void seen.push(hook))

    const drives = app.container.get(DRIVES)
    const view = await drives.connect({ provider: 'fake', label: 'X', tokens: { accessToken: 'a' } })
    await drives.disconnect(view.id, { revoke: false })

    expect(seen).toContain('drive:connected')
    expect(seen).toContain('drive:disconnected')
    await app.shutdown()
  })
})
