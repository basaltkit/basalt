import { createToken, definePlugin, ensureMetadata } from '@basaltkit/core'
import type { RequestEnricher, RouteGuard } from '@basaltkit/http'
import { ApiKeys, ScopeRequiredError, scopesSatisfy, type ApiKeyContext, type ApiKeysOptions } from './apikeys.js'
import { publicUser } from './auth.js'
import type { UserSource } from './stores.js'

declare module '@basaltkit/core' {
  interface RequestContext {
    /** Set when the request authenticated with an API key instead of a session. */
    apiKey?: ApiKeyContext
  }
  interface BasaltHooks {
    'auth:apikey_issued': { id: string; tenantId?: string; userId?: string }
    'auth:apikey_revoked': { id: string }
  }
}

export const API_KEYS = createToken<ApiKeys>('auth:apikeys')

export interface ApiKeysPluginOptions extends ApiKeysOptions {
  /**
   * Header carrying the key, besides `Authorization: Bearer mk_...`.
   * Default `x-api-key`.
   */
  header?: string
  /**
   * When provided, a key that carries a `userId` also populates `ctx().user`,
   * so scope-guarded routes can read the acting user.
   */
  users?: UserSource
}

/**
 * Programmatic access via API keys. Registers an enricher that authenticates
 * `mk_`-prefixed bearers (or the configured header) and a guard that enforces
 * `meta.scopes` on routes. Pair with {@link apiKeyRoutes} for CRUD endpoints.
 */
export function apiKeysPlugin(options: ApiKeysPluginOptions = {}) {
  const header = options.header ?? 'x-api-key'
  return definePlugin({
    name: 'basalt:apikeys',
    register({ container, hooks }) {
      container.singleton(API_KEYS, () => new ApiKeys({ ...options, hooks }))
      const metadata = ensureMetadata(container)

      const enricher: RequestEnricher = async ({ request, context, container: c }) => {
        const authHeader = request.headers.authorization
        const bearer =
          typeof authHeader === 'string' && authHeader.startsWith('Bearer mk_')
            ? authHeader.slice('Bearer '.length)
            : undefined
        const custom = request.headers[header]
        const presented = bearer ?? (typeof custom === 'string' ? custom : undefined)
        if (!presented) return

        const record = await c.get(API_KEYS).verify(presented)
        if (!record) return

        context.apiKey = {
          id: record.id,
          scopes: record.scopes,
          ...(record.tenantId !== undefined ? { tenantId: record.tenantId } : {}),
          ...(record.userId !== undefined ? { userId: record.userId } : {}),
        }
        if (record.userId && options.users) {
          const user = await options.users.findById(record.userId)
          if (user) context.user = publicUser(user)
        }
      }
      metadata.add('http:enrichers', enricher)

      // Guard: a route declaring meta.scopes needs an API key holding them all.
      const guard: RouteGuard = ({ route, context }) => {
        const required = route.meta?.['scopes']
        if (!Array.isArray(required) || required.length === 0) return
        const granted = context.apiKey?.scopes ?? []
        for (const scope of required as string[]) {
          if (!scopesSatisfy(granted, [scope])) throw new ScopeRequiredError(scope)
        }
      }
      metadata.add('http:guards', guard)
      // Claim `meta.scopes` for the adapters' boot-time guarded-meta check —
      // a scope-gated route without this plugin would serve unchecked.
      metadata.add('http:guarded-meta', 'scopes')
    },
  })
}
