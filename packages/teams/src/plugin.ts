import { createToken, definePlugin, ensureMetadata, tryCtx, type Container, type HookBus } from '@basaltkit/core'
import type { RouteGuard, RouteMetaValidator, RouteVisibilityCheck } from '@basaltkit/http'
import {
  InsufficientTeamRoleError,
  NotATeamMemberError,
  Teams,
  UnknownTeamRoleError,
  type TeamsOptions,
} from './teams.js'
import type { Membership, PublicInvitation, TeamRole } from './stores.js'

declare module '@basaltkit/core' {
  interface BasaltHooks {
    /** An invitation was created — the app emails the token as a link. */
    'team:invited': { invitation: PublicInvitation; token: string }
    'team:joined': { membership: Membership }
    'team:role_changed': { membership: Membership }
    'team:member_removed': { tenantId: string; userId: string }
    /**
     * `acceptOnVerifiedEmail` could not enroll a verified user into the
     * current tenant (a store error, …). The login / verification that
     * triggered it went through regardless; the invitation stays pending.
     */
    'team:auto_accept_failed': { tenantId: string; userId: string; error: unknown }
  }
}

export const TEAMS = createToken<Teams>('teams')

export interface TeamsPluginOptions extends Omit<TeamsOptions, 'hooks'> {
  /**
   * Accept a pending invitation without the link once the invited address is
   * proven: on `auth:email_verified` and on `auth:login` (which
   * `@basaltkit/auth` emits only after MFA), the signed-in user's pending
   * invitation to the CURRENT tenant (`ctx().tenant`) is accepted through
   * {@link Teams.acceptByEmail} when their email is verified. Covers both
   * orders: invited then verified, and verified then invited (next sign-in).
   *
   * Tenant-scoped: on the apex (no tenant) nothing happens, and other tenants'
   * invitations are never touched. It never fails the login: an error is
   * reported through the `team:auto_accept_failed` hook and swallowed.
   * Default `false`.
   */
  acceptOnVerifiedEmail?: boolean
}

/** The `{ user }` payload of `auth:email_verified` / `auth:login`, read structurally. */
const verifiedUserOf = (payload: unknown): { id: string; email: string; emailVerified: boolean } | null => {
  const user = (payload as { user?: { id?: unknown; email?: unknown; emailVerified?: unknown } } | null)?.user
  if (!user || typeof user.id !== 'string' || typeof user.email !== 'string') return null
  return { id: user.id, email: user.email, emailVerified: user.emailVerified === true }
}

/** Wires {@link TeamsPluginOptions.acceptOnVerifiedEmail}. Never throws into the emitter. */
const subscribeAutoAccept = (container: Container, hooks: HookBus): void => {
  const handler = async (payload: unknown): Promise<void> => {
    const user = verifiedUserOf(payload)
    if (!user || !user.emailVerified) return
    const tenantId = (tryCtx() as { tenant?: { id?: unknown } } | undefined)?.tenant?.id
    if (typeof tenantId !== 'string' || tenantId === '') return
    try {
      await container.get(TEAMS).acceptByEmail({ tenantId, userId: user.id, email: user.email, emailVerified: true })
    } catch (error) {
      try {
        await hooks.emit('team:auto_accept_failed', { tenantId, userId: user.id, error })
      } catch {
        // A failing observer must not fail the login either.
      }
    }
  }
  // Structural subscription: teams never imports @basaltkit/auth.
  hooks.on('auth:email_verified', handler)
  hooks.on('auth:login', handler)
}

/**
 * Team membership + invitations. Registers the {@link Teams} service and a
 * guard enforcing `meta.teamRole` on routes: the current user (`ctx().user`)
 * must hold that role or higher in the current tenant (`ctx().tenant`).
 */
export function teamsPlugin(pluginOptions: TeamsPluginOptions = {}) {
  const { acceptOnVerifiedEmail, ...options } = pluginOptions
  return definePlugin({
    name: 'basalt:teams',
    boot({ container, hooks }) {
      if (acceptOnVerifiedEmail === true) subscribeAutoAccept(container, hooks)
    },
    register({ container, hooks }) {
      container.singleton(TEAMS, () => new Teams({ ...options, hooks }))
      const metadata = ensureMetadata(container)

      const guard: RouteGuard = async ({ route, context, container: c }) => {
        const required: unknown = route.meta?.['teamRole']
        // Same opt-off rule as the adapters' boot check: only `undefined` and
        // `false` mean "no requirement". Anything else was declared — and the
        // boot check counts it as protected — so an empty string, a typo
        // (`'Admin'`) or a non-string is a misconfiguration: fail closed.
        if (required === undefined || required === false) return
        const teams = c.get(TEAMS)
        if (!teams.isKnownRole(required)) throw new UnknownTeamRoleError(required)

        const ctxLike = context as { tenant?: { id: string }; user?: { id: string } }
        const tenantId = ctxLike.tenant?.id
        const userId = ctxLike.user?.id
        if (!tenantId || !userId) throw new NotATeamMemberError()

        if (!(await teams.can(tenantId, userId, required))) {
          throw new InsufficientTeamRoleError(required)
        }
      }
      metadata.add('http:guards', guard)
      // Claim `meta.teamRole` for the adapters' boot check (routes declaring
      // it without this plugin fail loud at boot instead of serving unchecked).
      metadata.add('http:guarded-meta', 'teamRole')

      // Boot-time twin of the guard's first check: a typo'd role fails the
      // boot (every adapter runs `http:meta-validators` over its routes)
      // instead of waiting for the first request to answer TEAM_ROLE_UNKNOWN.
      // The guard keeps its own check — `runRoute()` callers without an
      // adapter, and routes mounted outside the adapter's list, still fail closed.
      const validator: RouteMetaValidator = ({ route, container: c }) => {
        const required: unknown = route.meta?.['teamRole']
        if (required === undefined || required === false) return
        if (c.get(TEAMS).isKnownRole(required)) return
        return (
          `meta.teamRole ${JSON.stringify(required) ?? String(required)} is not a known team role ` +
          `(rank it in teamsPlugin({ roleRank }) or list it in grantableRoles)`
        )
      }
      metadata.add('http:meta-validators', validator)

      // Side-effect-free twin of the guard for listings (`tools/list` of
      // @basaltkit/mcp): hide a teamRole route from a caller who cannot hold
      // the role here. A membership read, nothing else — no hooks, no writes.
      const visibility: RouteVisibilityCheck = async ({ route, context, container: c }) => {
        const required: unknown = route.meta?.['teamRole']
        if (required === undefined || required === false) return true
        const teams = c.get(TEAMS)
        if (!teams.isKnownRole(required)) return false
        const ctxLike = context as { tenant?: { id?: unknown }; user?: { id?: unknown } }
        const tenantId = ctxLike.tenant?.id
        const userId = ctxLike.user?.id
        if (typeof tenantId !== 'string' || typeof userId !== 'string' || !tenantId || !userId) return false
        return teams.can(tenantId, userId, required)
      }
      metadata.add('http:route-visibility', visibility)
    },
  })
}

export interface TenantMembershipPluginOptions {
  /**
   * Require a minimum RANKED role instead of plain membership. Default:
   * undefined — any membership record passes (an existence check), so members
   * holding custom roles that are absent from `roleRank` are not rejected.
   * Set e.g. `role: 'member'` to enforce rank semantics explicitly.
   */
  role?: TeamRole
  /**
   * Context-level escape hatch for identities that legitimately cross tenants
   * (platform admins, support impersonation). Return true to skip the
   * membership check for this request, e.g.
   * `exempt: ({ user }) => user?.platformAdmin === true`. Prefer this over
   * marking routes `meta.central` when the exemption is about WHO is calling
   * (central disables the guard for everyone on that route).
   */
  exempt?: (context: Record<string, unknown>) => boolean
  /**
   * Opt-in decision cache. Without it every authenticated, tenant-scoped
   * request costs one membership lookup (a single indexed PK read — usually
   * fine). With it, decisions are cached in-process for `ttlMs` and
   * invalidated immediately by the `team:joined` / `team:role_changed` /
   * `team:member_removed` hooks, so same-process changes are always exact;
   * `ttlMs` only bounds staleness for changes made on ANOTHER replica —
   * i.e. a member removed elsewhere may retain access for up to `ttlMs`.
   * Size-bounded by `maxEntries` (default 10_000, oldest evicted).
   */
  cache?: { ttlMs: number; maxEntries?: number }
}

/**
 * Secure-by-default tenant isolation guard. On EVERY authenticated,
 * tenant-scoped request it asserts that `ctx().user` holds a membership in the
 * resolved `ctx().tenant` (rank is only enforced with an explicit `role`) —
 * closing the gap where a tenant is resolved from
 * client-supplied input (`x-tenant-id` header / `Host`) without checking that
 * the caller actually belongs to it.
 *
 * The guard runs only when BOTH a tenant and a user are present (i.e. an
 * authenticated request that resolved a tenant). It is skipped for:
 *  - routes with no resolved tenant (central/platform routes),
 *  - account routes, `meta: { account: true }` — routes about the caller's own
 *    identity rather than the tenant's data. `authRoutes()`, `mfaRoutes()`,
 *    `oauthRoutes()` (`@basaltkit/auth`) and the invite-accept route of
 *    `teamRoutes()` declare it, so a non-member can sign in and accept an
 *    invitation on the company's tenant. `account` is a neutral key: any
 *    package can mark its own account-scoped routes with it, and
 *  - routes that explicitly opt out with `meta: { central: true }` — used by
 *    the routes that legitimately act across/outside a single tenant
 *    (tenant creation, platform admin).
 *
 * Register it alongside `authPlugin`, `tenancyPlugin` and `teamsPlugin`.
 * Treat tenant *resolution* as identification, never authorization.
 */
export function tenantMembershipPlugin(options: TenantMembershipPluginOptions = {}) {
  const required = options.role
  const cacheKey = (tenantId: string, userId: string): string => `${tenantId}\u0000${userId}`
  const cache = options.cache ? new Map<string, { ok: boolean; until: number }>() : undefined
  const ttlMs = options.cache?.ttlMs ?? 0
  const maxEntries = options.cache?.maxEntries ?? 10_000
  // Bumped on every invalidation. A lookup only caches its decision if no
  // invalidation happened while it was in flight — otherwise a removal landing
  // between the store read and cache.set would be overwritten by a stale "member".
  // One global counter (not per key) keeps memory bounded; the cost is only a
  // skipped cache write for lookups that overlap any membership change.
  let generation = 0

  return definePlugin({
    name: 'basalt:teams:membership',
    register({ container, hooks }) {
      const metadata = ensureMetadata(container)

      if (cache) {
        // Precise same-process invalidation: any membership mutation drops the
        // cached decision, so only cross-replica changes wait out the TTL.
        const drop = (tenantId: string, userId: string) => {
          generation++
          cache.delete(cacheKey(tenantId, userId))
        }
        hooks.on('team:joined', ({ membership }) => drop(membership.tenantId, membership.userId))
        hooks.on('team:role_changed', ({ membership }) => drop(membership.tenantId, membership.userId))
        hooks.on('team:member_removed', ({ tenantId, userId }) => drop(tenantId, userId))
      }

      const isMember = async (teams: Teams, tenantId: string, userId: string): Promise<boolean> => {
        // Existence by default: a membership guard asks "does a membership
        // record exist?", not "does the role outrank 'member'?" — otherwise a
        // genuine member with a custom role missing from roleRank (rank 0)
        // would be rejected. Rank semantics apply only with an explicit `role`.
        if (required !== undefined) {
          // A typo'd `role` must not silently degrade into an exact-match check
          // nobody passes (or, before 4.0, a rank-0 check everybody passed).
          if (!teams.isKnownRole(required)) throw new UnknownTeamRoleError(required)
          return teams.can(tenantId, userId, required)
        }
        return (await teams.roleOf(tenantId, userId)) !== null
      }

      const guard: RouteGuard = async ({ route, context, container: c }) => {
        if (route.meta?.['central'] === true) return
        // Account routes act on the caller's own identity (sign-in, profile,
        // MFA, accepting an invitation), not on the tenant's data — the caller
        // is by definition allowed to be a non-member there.
        if (route.meta?.['account'] === true) return

        const ctxLike = context as { tenant?: { id: string }; user?: { id: string } }
        const tenantId = ctxLike.tenant?.id
        const userId = ctxLike.user?.id
        // Only authenticated, tenant-scoped requests are membership-checked.
        if (!tenantId || !userId) return

        // WHO-based escape (platform admin, support) — never cached: the
        // predicate is in-memory and may depend on more than (tenant, user).
        if (options.exempt?.(context as Record<string, unknown>) === true) return

        if (cache) {
          const hit = cache.get(cacheKey(tenantId, userId))
          if (hit && hit.until > Date.now()) {
            if (hit.ok) return
            throw new NotATeamMemberError()
          }
        }

        const startedAt = generation
        const ok = await isMember(c.get(TEAMS), tenantId, userId)

        if (cache && generation === startedAt) {
          // Bounded: evict oldest entries rather than growing without limit.
          while (cache.size >= maxEntries) {
            const oldest = cache.keys().next().value
            if (oldest === undefined) break
            cache.delete(oldest)
          }
          cache.set(cacheKey(tenantId, userId), { ok, until: Date.now() + ttlMs })
        }

        if (!ok) throw new NotATeamMemberError()
      }
      metadata.add('http:guards', guard)
    },
    boot({ container }) {
      // A typo'd `role` fails the boot, not the first tenant-scoped request.
      // (The guard keeps checking too — it is what enforces it at runtime.)
      if (required !== undefined && container.has(TEAMS) && !container.get(TEAMS).isKnownRole(required)) {
        throw new UnknownTeamRoleError(required)
      }
    },
  })
}
