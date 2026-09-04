import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * B18 · a patch of this package must not put a second adapter in the tree.
 *
 * `@basaltkit/testing` declared `@basaltkit/express` and `@basaltkit/hono` as
 * optional peers — the app's copy is used — but `@basaltkit/fastify` as a plain
 * dependency, because fastify is the default adapter.
 *
 * That asymmetry has a cost that only shows up on a version skew. When this
 * package moved its fastify range to `^2` while an application was still on
 * `1.x`, pnpm installed **both**, and `createTestApp` resolved a `FASTIFY`
 * token from a different copy than the one the app's `fastifyPlugin`
 * registered — two `createToken('fastify')` objects, two identities.
 *
 * The error said:
 *
 *     UnknownTokenError: No provider registered for token "fastify".
 *     Register it with container.singleton()/scoped()/transient() in some plugin.
 *
 * Five untouched tests failed, and the message pointed at a missing plugin. It
 * took half an hour to reach the real cause, which is named nowhere in it.
 *
 * A peer cannot duplicate: there is one copy, the application's, and a version
 * skew surfaces at install time as a peer warning instead of at runtime as a
 * token that does not exist.
 */

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

const ADAPTERS = ['@basaltkit/fastify', '@basaltkit/express', '@basaltkit/hono']

describe('F-32 · adapters are peers, never dependencies', () => {
  it('declares every adapter as an optional peer', () => {
    for (const adapter of ADAPTERS) {
      expect(pkg.peerDependencies?.[adapter], `${adapter} must be a peer`).toBeDefined()
      expect(pkg.peerDependenciesMeta?.[adapter]?.optional, `${adapter} must be optional`).toBe(true)
    }
  })

  it('depends on none of them directly', () => {
    // The regression guard. A dependency here is a second copy in somebody's
    // tree the day the ranges diverge, and the symptom names neither this
    // package nor the version skew that caused it.
    for (const adapter of ADAPTERS) {
      expect(pkg.dependencies?.[adapter], `${adapter} must not be a dependency`).toBeUndefined()
    }
  })

  it('does not pull an HTTP framework in either', () => {
    // `fastify` itself, not the Basalt adapter: shipping it as a dependency
    // puts a second fastify in the tree for the same reason.
    for (const framework of ['fastify', 'express', 'hono']) {
      expect(pkg.dependencies?.[framework], `${framework} must not be a dependency`).toBeUndefined()
    }
  })
})
