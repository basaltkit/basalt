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

  // ── tenancy ───────────────────────────────────────────────────────────────
  defineRule({
    id: 'tenant-scoping-missing',
    category: 'tenancy',
    check(ctx) {
      if (!ctx.stack.tenancy || !ctx.prisma) return null
      const unscoped = ctx.prisma.models.filter(
        (model) => !model.tenantScoped && !GLOBAL_MODELS.has(model.name),
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
]

/** Models that legitimately have no tenantId (platform-global tables). */
const GLOBAL_MODELS = new Set(['Tenant', 'User', 'Plan', 'WebhookEvent', 'Migration'])
