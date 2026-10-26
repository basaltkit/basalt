import type { PrismaModel, SourceHint } from '../context/project.js'
import { defineRule, type DoctorRule } from './types.js'

/**
 * Built-in diagnostic rules. Each is pure over a {@link ProjectContext}, so they
 * run offline with no API key. New rules are added here (or supplied to
 * {@link runDoctor}).
 */
export const DEFAULT_RULES: DoctorRule[] = [
  // ── observability ─────────────────────────────────────────────────────────
  defineRule({
    id: 'prisma-lazy-boot',
    category: 'observability',
    check(ctx) {
      if (!ctx.stack.orm || !ctx.server) return null
      if (ctx.server.connectsAtBoot) return null
      return {
        id: 'prisma-lazy-boot',
        title: 'Database connection is not validated at boot',
        severity: 'warning',
        category: 'observability',
        detected: `${ctx.server.path} never calls prisma.$connect() before listen()`,
        recommended: "await the Prisma client's $connect() right after boot()",
        reason:
          'Prisma connects lazily on the first query, so an unreachable database ' +
          '(wrong host/port/credentials) does NOT crash at startup — it fails ' +
          'silently on the first request instead.',
        fix: [
          'const app = await buildApp({ /* … */ }).boot()',
          "await app.container.get(PRISMA).$connect()  // fail loudly if the DB is unreachable",
        ].join('\n'),
        docs: '/guide/observability',
      }
    },
  }),
  defineRule({
    id: 'fastify-logger-off',
    category: 'observability',
    check(ctx) {
      if (ctx.stack.http !== 'fastify' || !ctx.app) return null
      if (ctx.app.fastifyLoggerConfigured) return null
      return {
        id: 'fastify-logger-off',
        title: "Fastify's request logger is disabled",
        severity: 'warning',
        category: 'observability',
        detected: `fastifyPlugin in ${ctx.app.path} has no fastify.logger option`,
        recommended: "enable Fastify's logger (at least in development)",
        reason:
          "Unhandled request errors are logged via request.log.error, but Fastify's " +
          'built-in logger defaults to OFF — so 500s are returned to the client while ' +
          'the terminal stays silent.',
        fix: "fastifyPlugin({ routes: [...], fastify: { logger: env.NODE_ENV === 'development' } })",
        docs: '/guide/observability',
      }
    },
  }),

  // ── security ──────────────────────────────────────────────────────────────
  defineRule({
    id: 'insecure-app-secret',
    category: 'security',
    check(ctx) {
      const value = ctx.env?.appSecretDefault
      if (!value) return null
      if (!/change|me|example|secret|placeholder|xxx/i.test(value)) return null
      return {
        id: 'insecure-app-secret',
        title: 'APP_SECRET has an insecure default',
        severity: 'error',
        category: 'security',
        detected: `${ctx.env?.path} defaults APP_SECRET to "${value}"`,
        recommended: 'require APP_SECRET from the environment with no fallback in production',
        reason:
          'A committed default secret lets anyone forge sessions/JWTs if it ever ' +
          'reaches a deployed environment. Secrets must come from the environment.',
        fix: "APP_SECRET: z.string().min(32)  // no .default() — fail fast if unset",
        docs: '/guide/security',
      }
    },
  }),

  defineRule({
    id: 'missing-security-plugin',
    category: 'security',
    check(ctx) {
      if (!ctx.app) return null
      if (ctx.app.pluginCalls.includes('securityPlugin')) return null
      return {
        id: 'missing-security-plugin',
        title: 'No securityPlugin — responses ship without secure headers',
        severity: 'warning',
        category: 'security',
        detected: `${ctx.app.path} registers no securityPlugin()`,
        recommended:
          'add securityPlugin() so secure response headers are set, and enable rate limiting + a CORS allow-list for production',
        reason:
          'Without it the API returns no security headers (HSTS, X-Frame-Options, ' +
          'nosniff, …) and applies no rate limiting — a fresh deploy is unprotected ' +
          'at the edge. The security primitives exist but are off until wired.',
        fix: 'securityPlugin({ /* headers on by default */ rateLimit: { limit: 120, windowMs: 60_000 } })',
        docs: '/guide/security',
      }
    },
  }),

  // ── tenancy ───────────────────────────────────────────────────────────────
  defineRule({
    id: 'missing-tenant-membership',
    category: 'tenancy',
    check(ctx) {
      if (!ctx.app || !ctx.stack.tenancy || !ctx.stack.auth) return null
      if (ctx.app.pluginCalls.includes('tenantMembershipPlugin')) return null
      // Fire whether or not @basaltkit/teams is installed: tenancy + auth with no
      // membership guard is the vulnerable shape regardless — staying silent
      // because the package providing the fix is absent hid it in fresh apps.
      const teamsInstalled =
        ctx.app.pluginCalls.includes('teamsPlugin') || ctx.installed.includes('@basaltkit/teams')
      return {
        id: 'missing-tenant-membership',
        title: 'Tenant is resolved from the request but membership is never enforced',
        severity: 'error',
        category: 'tenancy',
        detected: `${ctx.app.path} wires tenancy + auth${teamsInstalled ? ' (+ teams)' : ''} but no tenantMembershipPlugin`,
        recommended: teamsInstalled
          ? 'register tenantMembershipPlugin() so every authenticated, tenant-scoped request verifies the user belongs to the resolved tenant'
          : 'install @basaltkit/teams and register teamsPlugin() + tenantMembershipPlugin() so every authenticated, tenant-scoped request verifies the user belongs to the resolved tenant',
        reason:
          'Resolvers take the tenant from client input (x-tenant-id / Host). Without a ' +
          'membership check, any authenticated user can act on another tenant just by ' +
          'changing that header — a cross-tenant data breach. Tenant resolution is ' +
          'identification, never authorization.',
        fix: teamsInstalled
          ? 'tenantMembershipPlugin()  // central routes opt out with meta: { central: true }'
          : 'pnpm add @basaltkit/teams\n// then: teamsPlugin(), tenantMembershipPlugin()  // central routes opt out with meta: { central: true }',
        docs: '/guide/security',
      }
    },
  }),
  defineRule({
    id: 'platform-route-accepts-tenant',
    category: 'tenancy',
    check(ctx) {
      const hits = ctx.centralPlatformRoutes ?? []
      if (hits.length === 0) return null
      const where = hits.map((hit) => `${hit.path}:${hit.line}`).join(', ')
      return {
        id: 'platform-route-accepts-tenant',
        title: "Platform route declares tenant: false instead of tenant: 'never'",
        severity: 'warning',
        category: 'tenancy',
        detected: `platform routes still served on tenant hosts: ${where}`,
        recommended: "declare meta: { tenant: 'never' } on routes of the central plane",
        reason:
          '`tenant: false` lifts the tenant requirement but still resolves one: ' +
          'acme.<host>/platform/… runs inside Acme, against its database, and a ' +
          "tenant owner holding '*' satisfies 'platform:*'. `tenant: 'never'` answers " +
          'a tenant host with the plain 404 before any guard runs.',
        fix: "meta: { tenant: 'never', auth: true, can: 'platform:plans.manage' }",
        docs: '/guide/multi-tenant-pattern',
      }
    },
  }),
  defineRule({
    id: 'tenant-scoping-missing',
    category: 'tenancy',
    check(ctx) {
      if (!ctx.stack.tenancy || !ctx.prisma) return null
      const unscoped = ctx.prisma.models.filter(
        (model) => !model.tenantScoped && !GLOBAL_MODELS.has(model.name) && !isFrameworkGlobalModel(model),
      )
      if (unscoped.length === 0) return null
      const names = unscoped.map((m) => m.name).join(', ')
      return {
        id: 'tenant-scoping-missing',
        title: 'Tenant-scoped app has models without a tenantId',
        severity: 'warning',
        category: 'tenancy',
        detected: `models without a tenantId column: ${names}`,
        recommended: 'add a tenantId to tenant-owned models so queries can never leak across tenants',
        reason:
          'With tenancy enabled, a model that lacks tenantId cannot be isolated by ' +
          'the tenant-scoping layer — a query can return rows from other tenants.',
        fix: 'tenantId String  // + @@index([tenantId]); scope every query by the current tenant',
        docs: '/guide/tenancy',
      }
    },
  }),

  // ── database ──────────────────────────────────────────────────────────────
  defineRule({
    id: 'schema-not-migrated',
    category: 'database',
    check(ctx) {
      if (!ctx.prisma || !ctx.migrations) return null
      const created = new Set(ctx.migrations.tables)
      const missing = ctx.prisma.models.filter((model) => !created.has(tableOf(model).toLowerCase()))
      if (missing.length === 0) return null
      return {
        id: 'schema-not-migrated',
        title: 'Models with no migration — production will not have their tables',
        severity: 'error',
        category: 'database',
        detected: `no migration in ${ctx.migrations.path} creates: ${listOf(missing.map((m) => m.name))}`,
        recommended: 'create a migration for them and commit it',
        reason:
          'A deploy runs `prisma migrate deploy`, which builds only what the migrations ' +
          'create. A table that exists locally because of `prisma db push` is missing in ' +
          'production, and the first query on it fails.',
        fix: [
          'pnpm prisma migrate dev --name add_missing_tables',
          '// a database built with db push reports drift: generate the SQL with `prisma migrate diff`,',
          '// then mark it applied there with `prisma migrate resolve --applied <migration>`',
        ].join('\n'),
        docs: '/guide/persistence',
      }
    },
  }),
  defineRule({
    id: 'framework-schema-drift',
    category: 'database',
    check(ctx) {
      if (!ctx.prisma || !ctx.frameworkSchemas?.length) return null
      const own = new Map(ctx.prisma.models.map((model) => [model.name, model]))
      const gaps: string[] = []
      const packages = new Set<string>()
      for (const schema of ctx.frameworkSchemas) {
        for (const reference of schema.models) {
          const model = own.get(reference.name)
          if (!model) continue
          const missing = reference.fields.filter((field) => !model.fields.includes(field))
          if (missing.length === 0) continue
          gaps.push(...missing.map((field) => `${model.name}.${field}`))
          packages.add(schema.package)
        }
      }
      if (gaps.length === 0) return null
      return {
        id: 'framework-schema-drift',
        title: "Framework models are missing columns of the installed packages' schemas",
        severity: 'warning',
        category: 'database',
        detected: `missing from schema.prisma (${[...packages].join(', ')}): ${listOf(gaps)}`,
        recommended: 'copy the current models from the installed packages and migrate',
        reason:
          'A package upgrade can add columns its store writes. Until the schema has them, ' +
          'the store fails at runtime on the feature that uses them.',
        fix: 'pnpm basalt prisma:sync   # then: pnpm prisma migrate dev',
        docs: '/guide/persistence',
      }
    },
  }),

  // ── durability ────────────────────────────────────────────────────────────
  defineRule({
    id: 'memory-sources-in-use',
    category: 'durability',
    check(ctx) {
      const sources = ctx.app?.memorySources ?? []
      if (sources.length === 0) return null
      return {
        id: 'memory-sources-in-use',
        title: 'Non-durable in-memory sources are wired',
        severity: 'info',
        category: 'durability',
        detected: `${ctx.app?.path} uses ${sources.join(', ')}`,
        recommended: 'replace in-memory sources with database-backed ones before production',
        reason:
          'In-memory sources reset on every restart and are not shared across ' +
          'instances — fine for local dev, data loss in production.',
        docs: '/guide/tenancy',
      }
    },
  }),
  defineRule({
    id: 'redis-localhost-default',
    category: 'config',
    check(ctx) {
      const value = ctx.env?.redisUrlDefault
      if (!value || !/localhost|127\.0\.0\.1/.test(value)) return null
      if (!ctx.stack.queue && !ctx.stack.subscriptions) return null
      return {
        id: 'redis-localhost-default',
        title: 'Redis URL defaults to localhost',
        severity: 'info',
        category: 'config',
        detected: `${ctx.env?.path} defaults REDIS_URL to "${value}"`,
        recommended: 'set REDIS_URL from the environment in every non-local deployment',
        reason:
          'A localhost default silently falls back to a dev-only queue/dedupe backend ' +
          'in production if the env var is missing.',
        docs: '/guide/configuration',
      }
    },
  }),
  defineRule({
    id: 'in-memory-security-store',
    category: 'security',
    check(ctx) {
      const SECURITY_STORES: Record<string, string> = {
        MemoryPasskeyStore: 'WebAuthn passkeys',
        MemoryWebAuthnChallengeStore: 'WebAuthn challenges',
        MemoryAccessStore: 'roles & permissions',
        MemoryDomainStore: 'verified custom domains',
      }
      const hit = (ctx.app?.memorySources ?? []).find((source) => source in SECURITY_STORES)
      if (!hit) return null
      return {
        id: 'in-memory-security-store',
        title: 'Security state is kept in an in-memory store',
        severity: 'warning',
        category: 'security',
        detected: `${hit} holds ${SECURITY_STORES[hit]} in memory.`,
        recommended: 'Back it with a durable store (database/Redis) in production.',
        reason:
          'In-memory security stores are wiped on restart and are not shared across ' +
          'instances — passkeys/permissions/verified domains would silently reset or ' +
          'diverge per replica, which can lock users out or bypass authorization.',
        fix: `// swap ${hit} for a durable implementation of the same interface`,
        docs: '/guide/security',
      }
    },
  }),
  defineRule({
    id: 'plugin-default-memory-store',
    category: 'durability',
    check(ctx) {
      const stores = ctx.app?.defaultMemoryStores ?? []
      if (!ctx.app || !ctx.stack.orm || stores.length === 0) return null
      return {
        id: 'plugin-default-memory-store',
        title: 'Plugins keep their data in memory although the app has a database',
        severity: 'warning',
        category: 'durability',
        detected: `${ctx.app.path}: ${stores.map((s) => `${s.plugin}() without ${s.option}`).join(', ')}`,
        recommended: 'pass each one the durable store of its -prisma package',
        reason:
          'Left without a store these plugins fall back to memory: the data is gone on ' +
          'every restart and each instance sees its own copy.',
        fix: stores.map((s) => `pnpm add ${s.durable}   // ${s.plugin}({ ${s.option}: … })`).join('\n'),
        docs: '/guide/persistence',
      }
    },
  }),

  // ── correctness ───────────────────────────────────────────────────────────
  defineRule({
    id: 'context-at-module-scope',
    category: 'tenancy',
    check(ctx) {
      const hits = ctx.sourceHints?.moduleScopeContext ?? []
      if (hits.length === 0) return null
      return {
        id: 'context-at-module-scope',
        title: 'The request context is read while a module loads',
        severity: 'error',
        category: 'tenancy',
        detected: `ctx()/tryCtx()/db() in a top-level declaration: ${whereOf(hits)}`,
        recommended: 'call it inside the handler or function that needs it',
        reason:
          'At import time there is no request: ctx() and db() throw, and tryCtx() returns ' +
          'undefined, so the value is the same for every tenant and every request.',
        fix: 'const service = () => ctx().container.get(SERVICE)   // a function, called per request',
        docs: '/guide/concepts#context-asynclocalstorage',
      }
    },
  }),
  defineRule({
    id: 'detached-hook-bus',
    category: 'config',
    check(ctx) {
      const hits = ctx.sourceHints?.detachedHookBus ?? []
      if (hits.length === 0) return null
      return {
        id: 'detached-hook-bus',
        title: 'A HookBus of its own — the app\'s events never reach it',
        severity: 'warning',
        category: 'config',
        detected: `new HookBus() in ${whereOf(hits)}`,
        recommended: "listen on the app's bus: the `hooks` a plugin receives",
        reason:
          'Plugins emit on the bus the app creates. A bus built with new HookBus() is a ' +
          'separate one: its listeners are never called and nothing fails.',
        fix: "definePlugin({ name: 'x', boot({ hooks }) { hooks.on('comment:created', …) } })",
        docs: '/guide/concepts#hooks-hookbus',
      }
    },
  }),
  defineRule({
    id: 'zod-v3-import',
    category: 'config',
    check(ctx) {
      const hits = ctx.sourceHints?.zodV3Imports ?? []
      if (hits.length === 0) return null
      return {
        id: 'zod-v3-import',
        title: 'Schemas built with zod/v3',
        severity: 'warning',
        category: 'config',
        detected: `imports from 'zod/v3': ${whereOf(hits)}`,
        recommended: "import from 'zod' (Zod 4), as the framework does",
        reason:
          'Routes turn their schemas into OpenAPI and MCP tool input with Zod 4. A zod/v3 ' +
          'schema is a different object: those documents come out wrong or the conversion throws.',
        fix: "import { z } from 'zod'",
        docs: '/guide/concepts#the-neutral-route-pipeline',
      }
    },
  }),
]

/** Models that legitimately have no tenantId (platform-global tables). */
const GLOBAL_MODELS = new Set(['Tenant', 'User', 'Plan', 'WebhookEvent', 'Migration'])

/**
 * Models the framework's `-prisma` packages ship without a tenantId, by design:
 * identity is central (one AuthUser across tenants, membership checked by
 * tenantMembershipPlugin), and the others are scoped by their package. Keyed by
 * model name → its `@@map` table, and matched on both, so an app's own
 * `Payment` or `Subscription` is still checked. A test keeps this in sync with
 * the reference schemas.
 */
export const FRAMEWORK_GLOBAL_MODELS: Readonly<Record<string, string>> = {
  AuthUser: 'auth_users',
  AuthSession: 'auth_sessions',
  AuthRefreshToken: 'auth_refresh_tokens',
  AuthToken: 'auth_tokens',
  AuthMfa: 'auth_mfa',
  AuthTokenVersion: 'auth_token_versions',
  AuthAccountLink: 'auth_account_links',
  AuthPasskey: 'auth_passkeys',
  InAppNotification: 'in_app_notifications',
  NotificationPreference: 'notification_preferences',
  PermUserRole: 'perm_user_roles',
  PermUserPermission: 'perm_user_permissions',
  PermRolePermission: 'perm_role_permissions',
  PermTemporaryGrant: 'perm_temporary_grants',
  PermDelegation: 'perm_delegations',
  Subscription: 'subscriptions',
  UsageCounter: 'usage_counters',
  WebhookEvent: 'webhook_events',
  Payment: 'payments',
  RecurringSubscription: 'recurring_subscriptions',
  Tenant: 'tenants',
}

function isFrameworkGlobalModel(model: { name: string; table?: string }): boolean {
  const table = Object.hasOwn(FRAMEWORK_GLOBAL_MODELS, model.name) ? FRAMEWORK_GLOBAL_MODELS[model.name] : undefined
  return table !== undefined && table === model.table
}

/** The table a model maps to: its `@@map`, else its name. */
function tableOf(model: PrismaModel): string {
  return model.table ?? model.name
}

/** A list cut at ten entries, so a big schema does not flood the report. */
function listOf(items: string[]): string {
  return items.length > 10 ? `${items.slice(0, 10).join(', ')} (+${items.length - 10} more)` : items.join(', ')
}

function whereOf(hits: SourceHint[]): string {
  return listOf(hits.map((hit) => `${hit.path}:${hit.line}`))
}
