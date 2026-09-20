import { createToken, definePlugin, ensureMetadata } from '@basaltkit/core'
import { Drives, type DrivesOptions } from './drives.js'

export const DRIVES = createToken<Drives>('drives')

export type DrivesPluginOptions = Omit<DrivesOptions, 'hooks'>

/**
 * Registers {@link Drives} in the container.
 *
 * Like `filesPlugin` and `webhooksPlugin`, it learns whether the app is
 * multi-tenant from the container's `'tenancy:active'` marker rather than by
 * importing `@basaltkit/tenancy` — read on every call, so plugin registration
 * order does not decide whether tenant isolation is enforced.
 */
export function drivesPlugin(options: DrivesPluginOptions) {
  return definePlugin({
    name: 'basalt:drives',
    register({ container, hooks }) {
      const metadata = ensureMetadata(container)
      container.singleton(
        DRIVES,
        () => new Drives({ ...options, hooks }, () => metadata.get('tenancy:active').length > 0),
      )
    },
  })
}
