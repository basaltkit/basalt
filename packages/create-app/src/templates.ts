export interface ProjectOptions {
  name: string
  tenancy: boolean
  auth: boolean
  billing: boolean
  /** Scaffold a web/ frontend (React + shadcn + SDK). */
  ui: boolean
  /** Scaffold the `basalt` CLI entrypoint (code generators + built-in commands). */
  cli: boolean
  /** Expose opted-in routes as MCP tools (@basaltkit/mcp) over HTTP at `/mcp`. */
  mcp: boolean
  /**
   * Back the app with a real PostgreSQL database: a `prisma/schema.prisma`,
   * `src/db.ts`, `prismaPlugin({ assertMigrated: true })` and the Prisma-backed
   * stores instead of the in-memory ones.
   */
  prisma: boolean
}

import { THIRD_PARTY_VERSIONS } from './latest-versions.js'
import { SCAFFOLD_VERSIONS } from './versions.js'

export { SCAFFOLD_VERSIONS } from './versions.js'
export { THIRD_PARTY_VERSIONS } from './latest-versions.js'

/**
 * The dependency range for a @basaltkit/* package: the current release line
 * (`^<major>.<minor>.0`) of its workspace version, from the generated
 * {@link SCAFFOLD_VERSIONS} map. Throws for an unknown package rather than
 * guessing a range — a stale guess once pinned new apps to frozen 1.x lines.
 */
export const versionOf = (pkg: string): string => {
  const range = SCAFFOLD_VERSIONS[pkg]
  if (range === undefined) {
    throw new Error(`create-basalt: no release line for ${pkg} — add it to scripts/sync-versions.mjs.`)
  }
  return range
}

/**
 * The fallback range for a third-party package the templates emit, from
 * {@link THIRD_PARTY_VERSIONS}. At scaffold time the CLI replaces it with
 * `^<latest>` when the registry's latest is on the same major. Throws for an
 * unknown package so every emitted range lives in that single table.
 */
export const thirdPartyVersionOf = (pkg: string): string => {
  const range = THIRD_PARTY_VERSIONS[pkg]
  if (range === undefined) {
    throw new Error(`create-basalt: no fallback range for ${pkg} — add it to THIRD_PARTY_VERSIONS.`)
  }
  return range
}

/** True when the scaffold binds users to the tenant they act on (tenancy + auth). */
export const enforcesMembership = (options: ProjectOptions): boolean => options.tenancy && options.auth

export function packageJson(options: ProjectOptions): string {
  const basalt = ['@basaltkit/config', '@basaltkit/core', '@basaltkit/env', '@basaltkit/events', '@basaltkit/fastify', '@basaltkit/logger']
  if (options.tenancy) basalt.push('@basaltkit/tenancy')
  if (options.auth) basalt.push('@basaltkit/auth')
  // Tenancy + auth: @basaltkit/teams binds each user to the tenants they belong
  // to (tenantMembershipPlugin) — without it x-tenant-id/Host is a free choice.
  if (enforcesMembership(options)) basalt.push('@basaltkit/teams')
  if (options.billing) basalt.push('@basaltkit/subscriptions')
  if (options.mcp) basalt.push('@basaltkit/mcp')
  if (options.cli) {
    // Runtime deps: app.ts uses commandsPlugin (@basaltkit/cli); prisma powers
    // `basalt prisma:sync` (and prismaPlugin, wired by --prisma).
    // @basaltkit/generator is dev-only (below).
    basalt.push('@basaltkit/cli', '@basaltkit/prisma')
  }
  if (options.prisma) {
    // The database layer: prismaPlugin + tenancyExtension, plus the store
    // packages for whichever domains are on (the memory ones are gone).
    if (!options.cli) basalt.push('@basaltkit/prisma')
    if (options.tenancy) basalt.push('@basaltkit/tenancy-prisma')
    if (options.auth) basalt.push('@basaltkit/auth-prisma')
    if (enforcesMembership(options)) basalt.push('@basaltkit/teams-prisma')
    if (options.billing) basalt.push('@basaltkit/subscriptions-prisma')
  }
  const dependencies: Record<string, string> = { zod: thirdPartyVersionOf('zod') }
  for (const pkg of basalt) dependencies[pkg] = versionOf(pkg)
  if (options.prisma) {
    // Prisma 7 talks to PostgreSQL through a driver adapter, so `pg` is a real
    // runtime dependency (see src/db.ts); the `prisma` CLI is dev-only.
    for (const pkg of ['@prisma/adapter-pg', '@prisma/client', 'pg']) {
      dependencies[pkg] = thirdPartyVersionOf(pkg)
    }
  }

  const devDependencies: Record<string, string> = {
    '@basaltkit/testing': versionOf('@basaltkit/testing'),
  }
  for (const pkg of ['@types/node', 'pino-pretty', 'tsx', 'typescript', 'vitest']) {
    devDependencies[pkg] = thirdPartyVersionOf(pkg)
  }
  if (options.cli) {
    // Dev-only: only bin/basalt.ts imports the code generator — the runtime server
    // never does, so the app runs completely without the codegen/AI layer.
    devDependencies['@basaltkit/generator'] = versionOf('@basaltkit/generator')
  }
  if (options.mcp) {
    // Dev-only AI bridge: exposes analyze/plan/make to MCP clients (Claude
    // Code/Desktop) via the `basalt-ai-mcp` bin. NEVER a runtime dependency — the
    // app ships and runs without it (see `.mcp.json` for the client config).
    devDependencies['@basaltkit/ai-mcp'] = versionOf('@basaltkit/ai-mcp')
  }
  if (options.prisma) {
    for (const pkg of ['@types/pg', 'prisma']) devDependencies[pkg] = thirdPartyVersionOf(pkg)
  }

  return `${JSON.stringify(
    {
      name: options.name,
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: {
        // dev opts into NODE_ENV=development (src/dev.ts); start does not, so an
        // unset NODE_ENV counts as production and secrets are required.
        dev: 'tsx watch src/dev.ts',
        start: 'tsx src/server.ts',
        test: 'vitest run',
        typecheck: 'tsc --noEmit',
        ...(options.cli ? { basalt: 'tsx bin/basalt.ts' } : {}),
        ...(options.prisma
          ? {
              // Generate right after install so `pnpm typecheck` has the client
              // types (generation needs no database).
              postinstall: 'prisma generate',
              'db:generate': 'prisma generate',
              // Development and deployment BOTH go through migrations: they are
              // what creates `_prisma_migrations`, which the app's
              // prismaPlugin({ assertMigrated: true }) requires at boot. There
              // is deliberately no `db:push` script.
              'db:migrate': 'prisma migrate dev',
              'db:deploy': 'prisma migrate deploy',
              ...(options.tenancy ? { 'db:seed': 'tsx prisma/seed.ts' } : {}),
            }
          : {}),
      },
      dependencies: Object.fromEntries(Object.entries(dependencies).sort()),
      devDependencies: Object.fromEntries(Object.entries(devDependencies).sort()),
    },
    null,
    2,
  )}\n`
}

export function tsconfigJson(options: ProjectOptions): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noUncheckedIndexedAccess: true,
        verbatimModuleSyntax: true,
        skipLibCheck: true,
        noEmit: true,
        types: ['node'],
      },
      // The generated Prisma client lives under src/generated (git-ignored, and
      // re-created by `prisma generate`); the seed script under prisma/ is
      // type-checked too.
      include: ['src', 'tests', ...(options.prisma && options.tenancy ? ['prisma/seed.ts'] : [])],
    },
    null,
    2,
  )}\n`
}

export function envTs(options: ProjectOptions): string {
  const prefix = envPrefix(options.name)
  return `import { defineEnv${options.auth ? ', secret' : ''} } from '@basaltkit/env'
import { LOG_LEVELS } from '@basaltkit/logger'
import { z } from 'zod'

export const env = defineEnv(
  {
    PORT: z.coerce.number().default(3000),
    HOST: z.string().default('0.0.0.0'),
    // Typed against the logger's LogLevel union — a free-form string here fails
    // \`pnpm typecheck\` where loggerPlugin({ level }) consumes it.
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    // Unset counts as production (fail-closed); \`pnpm dev\` sets development.
    // NODE_ENV is a Node-wide convention and is never prefixed.
    NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),${
      options.prisma
        ? `
    // Required: the PostgreSQL connection string, read as ${prefix}_DATABASE_URL
    // first (a stray DATABASE_URL exported in your shell must not win — that is
    // how an app boots against another project's database). src/db.ts builds the
    // Prisma client from it; prisma.config.ts gives the CLI the same URL.
    DATABASE_URL: z.string().min(1),`
        : ''
    }${
      options.auth
        ? `
    // Signs JWTs and sessions. secret() is fail-closed: required unless NODE_ENV
    // is explicitly development/test (no fallback when NODE_ENV is unset),
    // rejected if it looks like a placeholder. \`pnpm dev\` uses devDefault.
    APP_SECRET: secret({ minLength: 32, devDefault: 'dev-only-insecure-secret-please-change-me' }),`
        : ''
    }
  },
  {
    // Every variable is read as ${prefix}_<NAME> first (${prefix}_PORT before PORT),
    // falling back to the bare name. \`--env-file\` never overrides a variable
    // already exported in your shell, so without the prefix another project's
    // exported PORT / DATABASE_URL would silently win. The keys above stay bare:
    // the rest of the app still reads env.PORT.
    // To require the prefixed names (no bare fallback at all), write:
    //   prefix: { value: '${prefix}', fallback: false }
    prefix: '${prefix}',
  },
)
`
}

/**
 * An app-specific env-var prefix derived from the project name
 * (`my-saas` → `MY_SAAS`), suggested for variables whose generic names
 * (`DATABASE_URL`, …) other projects export too.
 */
export function envPrefix(name: string): string {
  let base = name
    .replace(/^@[^/]+\//, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
  // Trim underscores in linear time (an anchored `_+$` regex backtracks).
  let start = 0
  let end = base.length
  while (start < end && base[start] === '_') start++
  while (end > start && base[end - 1] === '_') end--
  base = base.slice(start, end)
  return base === '' || /^\d/.test(base) ? `APP_${base}` : base
}

export function envExample(options: ProjectOptions): string {
  const prefix = envPrefix(options.name)
  return `# Nothing loads this file for you: copy it to .env and start with
# \`node --env-file=.env\` / \`tsx --env-file=.env\`, or export the variables.
# --env-file NEVER overrides a variable already exported in your shell: if
# another project exported PORT or DATABASE_URL, an app reading the generic
# name would silently use THAT one. That is why src/env.ts reads app-prefixed
# names — ${prefix}_PORT wins over a stray PORT. The bare names still work as a
# fallback, so an existing deployment exporting them keeps booting.
${prefix}_PORT=3000
${prefix}_HOST=0.0.0.0
${prefix}_LOG_LEVEL=info
# NODE_ENV is a Node-wide convention and is never prefixed.
NODE_ENV=development
${
    options.auth
      ? `# Required unless NODE_ENV is development/test — \`pnpm start\` refuses to boot
# without it. Generate a strong one:  openssl rand -base64 48
# ${prefix}_APP_SECRET=
`
      : ''
  }${
    options.prisma
      ? `# Required: the app does not boot without it. The Prisma CLI reads the same
# name from prisma.config.ts, so \`pnpm db:migrate\` and the running app always
# agree on which database they mean.
${prefix}_DATABASE_URL=postgres://postgres:postgres@localhost:5432/${databaseName(options.name)}
`
      : `# When you add a database, declare DATABASE_URL in src/env.ts and set it here
# under the prefixed name (or scaffold with --prisma, which does it for you):
# ${prefix}_DATABASE_URL=postgres://user:pass@localhost:5432/${options.name.replace(/^@[^/]+\//, '')}
`
  }`
}

/** A PostgreSQL-safe database name derived from the project name. */
export function databaseName(name: string): string {
  return name.replace(/^@[^/]+\//, '').replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()
}

export function appTs(options: ProjectOptions): string {
  const imports = [
    `import { createApp } from '@basaltkit/core'`,
    `import { configPlugin } from '@basaltkit/config'`,
    `import { eventsPlugin } from '@basaltkit/events'`,
    `import { fastifyPlugin, securityPlugin } from '@basaltkit/fastify'`,
    `import { loggerPlugin, type LogLevel } from '@basaltkit/logger'`,
  ]
  const plugins = [
    `configPlugin({ app: { name: '${options.name}' } })`,
    `loggerPlugin({ level: options.logLevel ?? 'info', ...(options.pretty ? { pretty: true } : {}) })`,
    `eventsPlugin()`,
    `securityPlugin({
      // Secure response headers (HSTS, X-Frame-Options, nosniff, …) are on by
      // default, and so is a global per-IP rate limit (auth routes add their
      // own stricter budget). Behind a proxy, make the adapter set request.ip
      // from it; with several replicas, pass a shared \`store\`.
      rateLimit: { limit: 120, windowMs: 60_000 },
      // Add a CORS allow-list if a browser app on another origin calls the API:
      // cors: { origin: ['https://app.example.com'], credentials: true },
    })`,
  ]
  let routesExpression = 'appRoutes'
  /** Module-level bindings emitted between the imports and `buildApp`. */
  const preamble: string[] = []

  if (options.prisma) {
    imports.push(`import { prismaPlugin } from '@basaltkit/prisma'`)
    imports.push(`import { db, prisma } from './db.js'`)
    plugins.push(`prismaPlugin({
      // \`db\` is the tenant-scoped client (src/db.ts): db<PrismaClient>() in a
      // handler returns it, already filtered by the request's tenant.
      client: db,
      // Fail the BOOT when this database is not the migrated one — a shell that
      // exported another project's DATABASE_URL, a typo in the database name.
      // Without it the app starts and dies on the first query instead. Needs
      // \`prisma migrate dev\`/\`migrate deploy\` (they write _prisma_migrations);
      // \`prisma db push\` does not, so never use it against this app.
      assertMigrated: true,
    })`)
  }

  if (options.tenancy) {
    if (options.prisma) {
      imports.push(
        `import { headerResolver, subdomainResolver, tenancyPlugin } from '@basaltkit/tenancy'`,
      )
      imports.push(`import { prismaTenantSource } from '@basaltkit/tenancy-prisma'`)
      // The stores read their own tables, outside any tenant context (a login
      // happens before a tenant is known) — so they take the UNSCOPED client.
      preamble.push(`/** Tenants live in the \`tenants\` table — seed one with \`pnpm db:seed\`. */
const tenants = prismaTenantSource(prisma)`)
      plugins.push(`tenancyPlugin({
      source: tenants,
      resolvers: [headerResolver(), subdomainResolver({ base: 'localhost' })],
    })`)
    } else {
      imports.push(
        `import { headerResolver, MemoryTenantSource, subdomainResolver, tenancyPlugin } from '@basaltkit/tenancy'`,
      )
      plugins.push(`tenancyPlugin({
      // Replace MemoryTenantSource with your database-backed source.
      source: new MemoryTenantSource().add({ id: 'demo', name: 'Demo Tenant' }),
      resolvers: [headerResolver(), subdomainResolver({ base: 'localhost' })],
    })`)
    }
  }
  if (options.auth) {
    if (options.prisma) {
      imports.push(`import { authPlugin, authRoutes, mfaRoutes } from '@basaltkit/auth'`)
      imports.push(`import { prismaAuthStores } from '@basaltkit/auth-prisma'`)
      imports.push(`import { env } from './env.js'`)
      preamble.push(`/** Users, sessions, refresh tokens, email/reset tokens, MFA and API keys. */
const authStores = prismaAuthStores(prisma)`)
      plugins.push(`authPlugin({
      users: authStores.users,
      sessions: authStores.sessions,
      refreshTokens: authStores.refreshTokens,
      // Email verification and password reset.
      tokens: authStores.tokens,
      mfa: authStores.mfa,
      secret: env.APP_SECRET,
    })`)
    } else {
      imports.push(`import { authPlugin, authRoutes, mfaRoutes, MemoryUserSource } from '@basaltkit/auth'`)
      imports.push(`import { env } from './env.js'`)
      plugins.push(`authPlugin({
      // Replace MemoryUserSource with your database-backed source (e.g.
      // @basaltkit/auth-sqlite or @basaltkit/auth-prisma). The default in-memory
      // MFA store is enough for the ready-made TOTP flow below.
      users: new MemoryUserSource(),
      secret: env.APP_SECRET,
    })`)
    }
    // authRoutes(): register, login, logout, refresh, me, email verification and
    // password recovery. mfaRoutes(): TOTP enroll/activate/status/disable.
    routesExpression = '[...appRoutes, ...authRoutes(), ...mfaRoutes()]'
  }
  if (enforcesMembership(options)) {
    // Secure by default: the tenant comes from client input (x-tenant-id / Host),
    // so it is identification, never authorization. tenantMembershipPlugin()
    // rejects (403) every authenticated request for a tenant the user is not a
    // member of. Routes that act outside a single tenant opt out with
    // meta: { central: true }.
    imports[0] = `import { createApp, definePlugin } from '@basaltkit/core'`
    imports.push(`import { TEAMS, teamsPlugin, tenantMembershipPlugin } from '@basaltkit/teams'`)
    if (options.prisma) {
      imports.push(`import { prismaTeamsStores } from '@basaltkit/teams-prisma'`)
      preamble.push(`/** Memberships and invitations (\`team_memberships\`, \`team_invitations\`). */
const teamStores = prismaTeamsStores(prisma)`)
      plugins.push(`teamsPlugin({
      memberships: teamStores.memberships,
      invitations: teamStores.invitations,
    })`)
    } else {
      plugins.push(`teamsPlugin({
      // TODO: the default membership/invitation stores are in-memory — pass
      // persistent ones (memberships, invitations) before production.
    })`)
    }
    plugins.push(`// Rejects authenticated requests for a tenant the user is not a member of.
      tenantMembershipPlugin()`)
    plugins.push(`// Dev-only seed: each new registrant joins the 'demo' tenant so the scaffold
      // works out of the box. Never in production — add members explicitly there
      // (on tenant creation, or via TEAMS invite()/accept()).
      ...(env.NODE_ENV === 'production' ? [] : [demoMembershipSeed()])`)
  }
  if (options.billing) {
    imports.push(`import { definePlans, subscriptionsPlugin } from '@basaltkit/subscriptions'`)
    if (options.prisma) {
      imports.push(`import { prismaSubscriptionsStores } from '@basaltkit/subscriptions-prisma'`)
      preamble.push(`/** Subscriptions, usage counters and webhook idempotency. */
const subscriptionStores = prismaSubscriptionsStores(prisma)`)
    }
    plugins.push(`subscriptionsPlugin({
      plans: definePlans({
        free: { price: 0, features: { projects: 3 } },
        pro: { price: { monthly: 29, yearly: 290 }, trial: '14d', features: { projects: 50 } },
      }),
      fallbackPlan: 'free',${
        options.prisma
          ? `
      store: subscriptionStores.store,
      usage: subscriptionStores.usage,
      webhooks: subscriptionStores.webhooks,`
          : ''
      }
    })`)
  }
  if (options.cli) {
    // Only the commandsPlugin lives here. The dev tools (@basaltkit/generator, and
    // @basaltkit/ai if installed) are imported ONLY by bin/basalt.ts and passed via
    // \`options.commands\`, so the runtime server never imports them — the SaaS runs
    // completely without the AI/codegen layer. Built-ins (routes, schedule:list) come free.
    imports.push(`import { commandsPlugin, type CommandDefinition } from '@basaltkit/cli'`)
    plugins.push(`...(options.commands && options.commands.length > 0 ? [commandsPlugin(options.commands)] : [])`)
  }
  let adapterRoutesExpr = routesExpression
  if (options.mcp) {
    imports.push(`import { mcpPlugin, mcpRoutes } from '@basaltkit/mcp'`)
    // The MCP server scans the SAME app routes for `meta.mcp` (see routes.ts); the
    // `/mcp` transport is added to the adapter so agents POST JSON-RPC to it. Tool
    // calls run through the neutral pipeline, so tenancy/auth apply unchanged.
    plugins.push(`mcpPlugin({ routes: ${routesExpression}, serverInfo: { name: '${options.name}', version: '0.1.0' } })`)
    adapterRoutesExpr =
      routesExpression === 'appRoutes'
        ? '[...appRoutes, ...mcpRoutes()]'
        : routesExpression.replace(/]$/, ', ...mcpRoutes()]')
  }
  plugins.push(`fastifyPlugin({ routes: ${adapterRoutesExpr} })`)

  const commandsField = options.cli
    ? `\n  /** Dev/CLI commands (make:*, ai:*, prisma:sync) — passed ONLY by bin/basalt.ts. */\n  commands?: CommandDefinition[]`
    : ''

  return `${imports.join('\n')}
import { appRoutes } from './routes.js'
${preamble.length > 0 ? `\n${preamble.join('\n\n')}\n` : ''}
export interface BuildAppOptions {
  logLevel?: LogLevel
  pretty?: boolean${commandsField}
}

export function buildApp(options: BuildAppOptions = {}) {
  return createApp({
    plugins: [
      ${plugins.join(',\n      ')},
    ],
  })
}
${
  enforcesMembership(options)
    ? `
/** Dev-only: adds each new registrant as a member of the 'demo' tenant. */
function demoMembershipSeed() {
  return definePlugin({
    name: 'app:demo-membership-seed',
    register({ container, hooks }) {
      hooks.on('auth:registered', async ({ user }) => {
        await container.get(TEAMS).addMember('demo', user.id, 'member')
      })
    },
  })
}
`
    : ''
}`
}

export function routesTs(options: ProjectOptions): string {
  const endpoints = [
    "'GET /'",
    "'GET /health'",
    ...(options.auth
      ? [
          "'POST /auth/register'",
          "'POST /auth/login'",
          "'POST /auth/refresh'",
          "'POST /auth/logout'",
          "'GET /auth/me'",
        ]
      : []),
  ]
  // Opt these read-only routes in as MCP tools when MCP is enabled. Only safe,
  // non-mutating endpoints are exposed — auth routes are deliberately left out.
  const overviewMeta = options.mcp
    ? `\n    meta: { mcp: { name: 'overview', description: 'List what this API exposes: name, status and available endpoints.' } },`
    : ''
  const healthMeta = options.mcp
    ? `\n    meta: { mcp: { name: 'health', description: 'Liveness check — returns ok and the current request id.' } },`
    : ''
  return `import { ctx } from '@basaltkit/core'
import { route } from '@basaltkit/fastify'

export const appRoutes = [
  // Friendly index so \`GET /\` is never a bare 404 — lists what the API exposes.
  route({
    method: 'GET',
    url: '/',${overviewMeta}
    async handler() {
      return {
        name: '${options.name}',
        status: 'ok',
        endpoints: [${endpoints.join(', ')}],
      }
    },
  }),
  route({
    method: 'GET',
    url: '/health',${healthMeta}
    async handler() {
      return { ok: true, requestId: ctx().requestId${
        options.tenancy ? ', tenant: ctx().tenant?.id ?? null' : ''
      } }
    },
  }),
]
`
}

export function serverTs(): string {
  return `import { FASTIFY } from '@basaltkit/fastify'
import { buildApp } from './app.js'
import { env } from './env.js'

const app = await buildApp({
  logLevel: env.LOG_LEVEL,
  pretty: env.NODE_ENV === 'development',
}).boot()

const server = app.container.get(FASTIFY)
await server.listen({ port: env.PORT, host: env.HOST })
console.log('ready at http://' + env.HOST + ':' + env.PORT)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.shutdown()
    process.exit(0)
  })
}
`
}

/**
 * `pnpm dev` entrypoint. Opts into NODE_ENV=development (dev secret defaults,
 * pretty logs) unless NODE_ENV is already set, then starts the server. Kept out
 * of server.ts on purpose: `pnpm start` runs server.ts directly, where an unset
 * NODE_ENV counts as production and secrets are required (fail-closed).
 */
export function devTs(): string {
  return `// Development entrypoint (\`pnpm dev\`). \`pnpm start\` runs server.ts directly,
// where an unset NODE_ENV counts as production: secrets are then required.
process.env['NODE_ENV'] ??= 'development'
await import('./server.js')
`
}

export function basaltBin(): string {
  return `#!/usr/bin/env node
import { runCli } from '@basaltkit/cli'
import { generatorCommands } from '@basaltkit/generator'
import { prismaSyncCommand } from '@basaltkit/prisma'

// Dev tooling: opt into development defaults unless NODE_ENV is already set
// (imported dynamically below so env.ts is evaluated after this line).
process.env['NODE_ENV'] ??= 'development'
const { buildApp } = await import('../src/app.js')

// The 'basalt' CLI: boots the app WITH the dev/CLI commands, runs one, shuts down.
// The dev tools (@basaltkit/generator; add @basaltkit/ai for ai:*) are imported
// ONLY here — the runtime server (src/server.ts) never loads them, so the SaaS
// runs without the codegen/AI layer.
//   pnpm basalt dev                     — dev server: route table + watch (--worker for a queue worker)
//   pnpm basalt list                    — show available commands
//   pnpm basalt routes                  — list registered HTTP routes
//   pnpm basalt make:resource Project   — generate a full resource vertical
//   pnpm basalt make:service Project    — generate a single artifact (schema/service/…)
const app = buildApp({
  logLevel: 'silent',
  commands: [...generatorCommands(), prismaSyncCommand()],
})
process.exit(await runCli({ app }))
`
}


/**
 * The models each `@basaltkit/<domain>-prisma` package needs, copied VERBATIM
 * from that package's reference `prisma/schema.prisma` — the same blocks
 * `basalt prisma:sync` merges into an existing schema. The scaffold ships the
 * merged result so a new app can run `prisma migrate dev` straight away;
 * `tests/prisma.test.ts` fails if a package's reference schema drifts from the
 * copy here.
 */
const PRISMA_MODELS: Readonly<Record<'tenancy' | 'auth' | 'teams' | 'subscriptions', string>> = {
  tenancy: `model Tenant {
  id      String         @id
  // The open tenant record ({ id, ...anything }) as JSON — attach whatever
  // per-tenant fields you like; they round-trip unchanged.
  data    Json
  domains TenantDomain[]

  @@map("tenants")
}

model TenantDomain {
  domain   String @id
  tenantId String
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([tenantId])
  @@map("tenant_domains")
}`,
  auth: `model AuthUser {
  id            String  @id
  email         String  @unique
  passwordHash  String
  emailVerified Boolean @default(false)

  @@map("auth_users")
}

model AuthSession {
  id        String   @id
  userId    String
  expiresAt DateTime

  @@index([userId])
  @@map("auth_sessions")
}

model AuthRefreshToken {
  token     String    @id
  familyId  String
  userId    String
  expiresAt DateTime
  usedAt    DateTime?

  @@index([familyId])
  @@index([userId])
  @@map("auth_refresh_tokens")
}

model AuthToken {
  token     String    @id
  userId    String
  purpose   String
  expiresAt DateTime
  usedAt    DateTime?

  @@index([userId, purpose])
  @@map("auth_tokens")
}

model AuthApiKey {
  id         String    @id
  name       String
  prefix     String
  hash       String    @unique
  tenantId   String?
  userId     String?
  scopes     String[]
  createdAt  DateTime
  expiresAt  DateTime?
  lastUsedAt DateTime?
  revokedAt  DateTime?

  @@index([tenantId])
  @@index([userId])
  @@map("auth_api_keys")
}

model AuthMfa {
  userId        String   @id
  secret        String
  enabled       Boolean  @default(false)
  recoveryCodes String[]
  lastUsedStep  Int?

  @@map("auth_mfa")
}

model AuthTokenVersion {
  userId  String @id
  version Int    @default(0)

  @@map("auth_token_versions")
}`,
  teams: `model TeamMembership {
  tenantId  String
  userId    String
  role      String
  createdAt DateTime

  @@id([tenantId, userId])
  @@map("team_memberships")
}

model TeamInvitation {
  id         String    @id
  tenantId   String
  email      String
  role       String
  token      String    @unique
  invitedBy  String?
  expiresAt  DateTime
  acceptedAt DateTime?
  revokedAt  DateTime?

  @@index([tenantId, email])
  @@map("team_invitations")
}`,
  subscriptions: `model Subscription {
  billableId        String    @id
  plan              String
  period            String
  status            String
  trialEndsAt       DateTime?
  cancelAtPeriodEnd Boolean?
  canceledAt        DateTime?
  gatewayRef        String?
  pendingPlan       String?
  pendingPeriod     String?

  @@map("subscriptions")
}

model UsageCounter {
  billableId String
  feature    String
  periodKey  String
  value      Int    @default(0)

  @@id([billableId, feature, periodKey])
  @@map("usage_counters")
}

model WebhookEvent {
  id     String   @id
  seenAt DateTime @default(now())

  @@map("webhook_events")
}`,
}

/**
 * `prisma/schema.prisma` — the datasource, the client generator, the models of
 * every Basalt domain this app enables, and the app's own first model.
 *
 * Prisma 7 no longer takes the connection URL here (prisma.config.ts does), and
 * the client needs an explicit `output`; src/db.ts imports it from there.
 */
export function prismaSchema(options: ProjectOptions): string {
  const domains: string[] = []
  if (options.tenancy) domains.push(PRISMA_MODELS.tenancy)
  if (options.auth) domains.push(PRISMA_MODELS.auth)
  if (enforcesMembership(options)) domains.push(PRISMA_MODELS.teams)
  if (options.billing) domains.push(PRISMA_MODELS.subscriptions)

  return `// Prisma schema for ${options.name}.
//
// The blocks below the header are the reference models of the @basaltkit/*-prisma
// packages this app uses — exactly what \`basalt prisma:sync\` merges. Add another
// Basalt domain later by installing its \`*-prisma\` package and running
// \`pnpm basalt prisma:sync\` (with --cli), then \`pnpm db:migrate\`.
//
// Apply changes with \`pnpm db:migrate\` (\`prisma migrate dev\`) — never
// \`prisma db push\`: push writes no _prisma_migrations table, and src/app.ts
// boots with prismaPlugin({ assertMigrated: true }), which requires it.

generator client {
  provider = "prisma-client-js"
  output   = "../src/generated/prisma"
}

datasource db {
  // The URL lives in prisma.config.ts (Prisma 7) — and in src/env.ts for the app.
  provider = "postgresql"
}
${domains.map((block) => `\n${block}\n`).join('')}
// ---------------------------------------------------------------------------
// Your models.${
    options.tenancy
      ? ` \`tenantId\` is the column tenancyExtension() (src/db.ts)
// forces onto every query and every write, so keep it on everything a tenant
// owns — and make cross-model foreign keys composite (@@unique([tenantId, id])
// on the target) so the database refuses a cross-tenant link too.`
      : ''
  }

model Project {
  id        String   @id @default(uuid())${options.tenancy ? '\n  tenantId  String' : ''}
  name      String
  createdAt DateTime @default(now())
${options.tenancy ? '\n  @@index([tenantId])' : ''}
  @@map("projects")
}
`
}

/**
 * `prisma.config.ts` — Prisma 7 reads the connection URL (and the seed command)
 * from here instead of from schema.prisma. It applies the SAME precedence as
 * src/env.ts: the app-prefixed name first, the bare `DATABASE_URL` only as a
 * fallback, so the CLI and the running app can never mean different databases.
 */
export function prismaConfigTs(options: ProjectOptions): string {
  const prefix = envPrefix(options.name)
  return `import { loadEnvFile } from 'node:process'
import { defineConfig } from 'prisma/config'

// Prisma loads no .env for you (neither does the app — see src/env.ts). This
// mirrors \`node --env-file=.env\`: a variable already exported in your shell
// still wins, the file only fills in what is missing.
try {
  loadEnvFile('.env')
} catch {
  // No .env file — the variables come from the environment.
}

export default defineConfig({
  schema: 'prisma/schema.prisma',${
    options.tenancy
      ? `
  // Runs after \`prisma migrate dev\` / \`prisma migrate reset\`.
  migrations: { seed: 'tsx prisma/seed.ts' },`
      : ''
  }
  datasource: {
    // ${prefix}_DATABASE_URL first, bare DATABASE_URL only as a fallback: a
    // stray DATABASE_URL from another project must never decide which database
    // gets migrated.
    url: process.env['${prefix}_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '',
  },
})
`
}

/**
 * `src/db.ts` — the Prisma client(s). Two bindings on purpose: the unscoped
 * `prisma` for the framework stores (they key their own rows and run outside a
 * tenant context) and, with tenancy, the `db` client the whole application uses,
 * where every query is filtered by the request's tenant.
 */
export function dbTs(options: ProjectOptions): string {
  return `import { PrismaPg } from '@prisma/adapter-pg'${
    options.tenancy ? `\nimport { tenancyExtension } from '@basaltkit/prisma'` : ''
  }
import { PrismaClient } from './generated/prisma/client.js'
import { env } from './env.js'

/**
 * The base client. Prisma 7 talks to PostgreSQL through a driver adapter, so the
 * connection string is passed here; prisma.config.ts hands the CLI the same one.
 *
 * ${
   options.tenancy
     ? `This client is NOT tenant-scoped: the framework stores (auth, tenancy,
 * teams, …) read and write their own tables, keyed by their own columns, and do
 * it before a tenant is known (a login has no tenant yet). Application code
 * should use \`db\` below — or \`db<PrismaClient>()\` from @basaltkit/prisma.`
     : `Application code can also reach it with \`db<PrismaClient>()\` from
 * @basaltkit/prisma, which returns the client registered by prismaPlugin.`
 }
 */
export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
})
${
  options.tenancy
    ? `
/**
 * The application client: tenancyExtension() forces the current tenant's
 * \`tenantId\` onto every read, stamps it onto every write, and fails closed
 * (MissingTenantError) when there is no tenant in context — application code
 * cannot forget the filter. src/app.ts registers it with prismaPlugin, so
 * \`db<PrismaClient>()\` inside a handler returns this one.
 */
export const db = prisma.$extends(tenancyExtension())
`
    : `
/** Registered by prismaPlugin in src/app.ts. */
export const db = prisma
`
}`
}

/**
 * `prisma/seed.ts` — creates the `demo` tenant the scaffolded resolvers expect
 * (`x-tenant-id: demo`, `demo.localhost`). Runs from `pnpm db:seed` and after
 * `prisma migrate dev` (prisma.config.ts declares it).
 */
export function prismaSeedTs(options: ProjectOptions): string {
  return `import { prismaTenantSource } from '@basaltkit/tenancy-prisma'
import { prisma } from '../src/db.js'

// The demo tenant the header and subdomain resolvers look for out of the box.
// \`save\` is an upsert, so re-seeding is safe. Tenants are open records: add
// whatever per-tenant fields you like — they round-trip unchanged.
const tenants = prismaTenantSource(prisma)
await tenants.save({ id: 'demo', name: 'Demo Tenant' })
console.log('Seeded tenant "demo" for ${options.name}.')

await prisma.$disconnect()
`
}

export function appTest(options: ProjectOptions): string {
  const prefix = envPrefix(options.name)
  // With a database the app cannot boot without one: src/env.ts requires
  // DATABASE_URL and prismaPlugin({ assertMigrated: true }) checks the schema.
  // So the suite is gated on a configured database and imports src/app.ts
  // lazily — an eager import would throw at module load instead of skipping.
  return `import { describe, expect, it } from 'vitest'
import { FASTIFY } from '@basaltkit/fastify'
${
  options.prisma
    ? `
// Needs a migrated database: set ${prefix}_DATABASE_URL (see .env.example), then
// \`pnpm db:migrate${options.tenancy ? ' && pnpm db:seed' : ''}\`. Without one the suite skips instead of failing.
const database = process.env['${prefix}_DATABASE_URL'] ?? process.env['DATABASE_URL']

describe.skipIf(!database)('app', () => {
  it('boots and responds on /health', async () => {
    const { buildApp } = await import('../src/app.js')
    const app = await buildApp({ logLevel: 'silent' }).boot()`
    : `import { buildApp } from '../src/app.js'

describe('app', () => {
  it('boots and responds on /health', async () => {
    const app = await buildApp({ logLevel: 'silent' }).boot()`
}
    const server = app.container.get(FASTIFY)

    const index = await server.inject({ method: 'GET', url: '/' })
    expect(index.statusCode).toBe(200)
    expect(index.json().name).toBe('${options.name}')

    const response = await server.inject({ method: 'GET', url: '/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json().ok).toBe(true)${
      options.tenancy
        ? `

    const tenant = await server.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-tenant-id': 'demo' },
    })
    expect(tenant.json().tenant).toBe('demo')`
        : ''
    }
    await app.shutdown()
  })
})
`
}

export function readme(options: ProjectOptions): string {
  const features = [
    'typed routes with Zod validation',
    'structured logging with request/tenant context',
    'typed domain events',
    ...(options.prisma ? ['PostgreSQL persistence through Prisma (migrations + tenant-scoped client)'] : []),
    ...(options.tenancy ? ['multi-tenancy (header + subdomain resolvers)'] : []),
    ...(options.auth ? ['authentication (register/login/refresh/me)'] : []),
    ...(options.billing ? ['subscriptions with plans and feature limits'] : []),
    ...(options.ui ? ['web UI (React + shadcn/ui on @basaltkit/admin-shadcn + @basaltkit/sdk)'] : []),
    ...(options.cli ? ['`basalt` CLI with code generators (`make:*`) and built-in commands'] : []),
    ...(options.mcp ? ['MCP server — read-only routes exposed as AI-agent tools at `/mcp`'] : []),
  ]
  return `# ${options.name}

A SaaS app scaffolded with [Basalt](https://github.com/basaltkit/basalt).

Included: ${features.join(' · ')}.

## Getting started

\`\`\`bash
pnpm install${
    options.prisma
      ? `
# point ${envPrefix(options.name)}_DATABASE_URL at a PostgreSQL database (.env.example), then
pnpm db:migrate # create the tables${options.tenancy ? ` (runs the seed too)` : ''}`
      : ''
  }
pnpm dev        # API on http://localhost:3000
pnpm test
\`\`\`
${
  options.prisma
    ? `
## Database

PostgreSQL through [Prisma](https://www.prisma.io). \`prisma/schema.prisma\` holds
the models this app needs — the reference models of the \`@basaltkit/*-prisma\`
packages it uses, plus your own \`Project\` at the end.

\`\`\`bash
pnpm db:migrate     # prisma migrate dev  — change the schema, write a migration${
        options.tenancy
          ? `
pnpm db:seed        # the 'demo' tenant the resolvers expect (also run by db:migrate)`
          : ''
      }
pnpm db:generate    # prisma generate — refresh src/generated/prisma (also runs on install)
pnpm db:deploy      # prisma migrate deploy — apply pending migrations in production
\`\`\`

**Never use \`prisma db push\` on this project.** \`src/app.ts\` boots with
\`prismaPlugin({ client: db, assertMigrated: true })\`, which refuses to start
unless the database it reached has the \`_prisma_migrations\` table — the one
\`migrate dev\` / \`migrate deploy\` write and \`db push\` does not. That check is
what turns "wrong \`DATABASE_URL\`" (a shell that exported another project's, a
typo in the database name) into a boot error naming the database and host,
instead of a 500 on the first request that touches a missing table.

\`src/db.ts\` exports two clients:

- \`prisma\` — unscoped. The framework stores (auth${options.tenancy ? ', tenancy' : ''}${
        enforcesMembership(options) ? ', teams' : ''
      }${options.billing ? ', subscriptions' : ''}) use it: they key
  their own tables and run before a tenant is known.${
    options.tenancy
      ? `
- \`db\` — \`prisma.$extends(tenancyExtension())\`. Registered with \`prismaPlugin\`,
  so \`db<PrismaClient>()\` inside a handler returns a client that filters every
  read by the request's tenant, stamps every write, and throws instead of running
  unscoped. Keep \`tenantId\` on every model a tenant owns.`
      : ''
  }
${
  options.cli
    ? `
Adding another Basalt domain later (audit, comments, notifications, …): install
its \`@basaltkit/<domain>-prisma\` package, run \`pnpm basalt prisma:sync\` to merge
its models into the schema, then \`pnpm db:migrate\`.
`
    : `
Adding another Basalt domain later (audit, comments, notifications, …): install
its \`@basaltkit/<domain>-prisma\` package, copy the models from its
\`schema.prisma\` into yours, then \`pnpm db:migrate\`. (With the \`basalt\` CLI —
scaffold with \`--cli\` — \`pnpm basalt prisma:sync\` does the merge for you.)
`
}
\`pnpm test\` skips the generated suite when no database is configured.
`
    : ''
}
## Environment

\`src/env.ts\` validates \`process.env\` — nothing loads \`.env\` for you. Copy
\`.env.example\` to \`.env\` and launch with \`--env-file=.env\` (Node/tsx), or
export the variables.

The variables are **app-prefixed**: \`${envPrefix(options.name)}_PORT\`,
\`${envPrefix(options.name)}_HOST\`, \`${envPrefix(options.name)}_LOG_LEVEL\`${
    options.auth ? `, \`${envPrefix(options.name)}_APP_SECRET\`` : ''
  }${
    options.prisma ? `, \`${envPrefix(options.name)}_DATABASE_URL\`` : ''
  }. \`NODE_ENV\` is never prefixed.

Why: **\`--env-file\` never overrides a variable that is already exported.** In a
shell where another project exported \`DATABASE_URL\` (or \`PORT\`), an app reading
the generic name boots against THAT value and only fails on the first request
that touches it. \`src/env.ts\` therefore passes \`prefix: '${envPrefix(options.name)}'\` to
\`defineEnv\`: each variable is read as \`${envPrefix(options.name)}_<NAME>\` first and
**falls back** to the bare \`<NAME>\`, so a deployment that already exports the
generic names keeps booting while a stray one in your shell loses.${
    options.prisma
      ? ` That is
exactly how \`DATABASE_URL\` is read here (\`${envPrefix(options.name)}_DATABASE_URL\` first), and
\`prisma.config.ts\` applies the same precedence — so \`pnpm db:migrate\` and the
running app can never mean two different databases.`
      : ` Add a
database and \`DATABASE_URL\` is read as \`${envPrefix(options.name)}_DATABASE_URL\`.`
  }

To drop the fallback entirely (prefixed names only), write
\`prefix: { value: '${envPrefix(options.name)}', fallback: false }\`. When in doubt about what
your shell exports: \`env | grep DATABASE_URL\`.
${
  options.cli
    ? `
## The \`basalt\` CLI

\`\`\`bash
pnpm basalt list                    # available commands
pnpm basalt routes                  # registered HTTP routes
pnpm basalt make:resource Project   # schema → repository → service → plugin → routes → test
pnpm basalt make:service Project    # a single artifact (--force to overwrite)
\`\`\`

Generated resources land in \`src/modules/<name>/\`. Register the generated
plugin in \`src/app.ts\` to wire it up.

With pnpm 11, \`pnpm basalt …\` first verifies dependencies
(\`verifyDepsBeforeRun\`, default \`install\`): when any workspace project is out
of sync it runs \`pnpm install\` — network included — before the command. To
run the CLI without that check, call it directly:

\`\`\`bash
node_modules/.bin/tsx bin/basalt.ts make:resource Project
\`\`\`

or set \`verifyDepsBeforeRun: warn\` in \`pnpm-workspace.yaml\` (a conscious
choice: you then run \`pnpm install\` yourself after dependency changes).
`
    : ''
}${
  options.ui
    ? `
## Web UI

\`\`\`bash
pnpm dev                       # terminal 1 — API on :3000
pnpm --filter ${options.name}-web dev   # terminal 2 — UI on http://localhost:5180
\`\`\`

Open <http://localhost:5180>. The Vite dev server proxies \`/api\` to the API,
so there is no CORS to configure${options.auth ? '. Register, then sign in' : ''}.
`
    : ''
}${
  options.mcp
    ? `
## MCP server

Read-only routes marked with \`meta.mcp\` in \`src/routes.ts\` (the overview and
health endpoints) are exposed as [Model Context Protocol](https://modelcontextprotocol.io)
tools over HTTP at \`POST /mcp\`. Point any MCP client at it:

\`\`\`bash
# list the tools
curl -s localhost:3000/mcp -H 'content-type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
\`\`\`

Tool calls run through the same neutral pipeline as HTTP, so validation, tenancy
and auth apply unchanged. Add \`meta: { mcp: true }\` to any route to expose it —
keep mutations and auth flows off unless an agent should really call them.

### AI dev tools

This project is also wired for AI-assisted development. \`.mcp.json\` registers the
**dev-only** \`basalt-ai-mcp\` bridge (a \`devDependency\` — never shipped in your
app's runtime) with MCP clients such as Claude Code and Claude Desktop. It exposes
\`basalt_analyze\`, \`basalt_doctor\`, \`basalt_plan\`, \`basalt_review\` and
\`basalt_make\` (preview by default, writes confined to this project) plus workflow
prompts. Claude Code picks up \`.mcp.json\` automatically; for Claude Desktop add the
same server to its config with \`--cwd=<absolute project path>\`.
`
    : ''
}`
}

/**
 * A Claude Code / generic MCP client config that registers the dev-only
 * `basalt-ai-mcp` bridge for this project. Claude Code reads `.mcp.json` at the
 * project root automatically; Claude Desktop uses the same server entry.
 */
export function mcpJson(_options: ProjectOptions): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        'basalt-ai': {
          command: 'npx',
          args: ['-y', '@basaltkit/ai-mcp', '--cwd=.'],
        },
      },
    },
    null,
    2,
  )}\n`
}

/**
 * Keeps secrets and local state out of Docker build contexts, so a
 * `COPY . .` can never bake `.env` or private keys into an image layer. Every
 * rule is `**`-prefixed: .dockerignore patterns are anchored at the context
 * root, so a bare `.env` or `*.pem` would still let `prisma/.env` or
 * `certs/server.key` through.
 */
export function dockerignore(): string {
  return `**/.env
**/.env.*
!**/.env.example
**/.npmrc
**/.git
**/node_modules
**/coverage
**/*.log
**/*.pem
**/*.key
**/*.p12
**/*.pfx
**/.DS_Store
`
}

export function gitignore(options: ProjectOptions): string {
  return `node_modules/
dist/
.env
.env.*
!.env.example
*.log
${
  options.prisma
    ? `# Generated by \`prisma generate\` (runs on install) — never edit or commit it.
src/generated/
`
    : ''
}`
}

/**
 * pnpm settings: esbuild's build script is required by tsx;
 * msgpackr-extract (optional native accelerator via BullMQ) is declined —
 * msgpackr falls back to pure JS. With --ui, `web` is a workspace member so
 * its own dependencies resolve.
 *
 * pnpm 11 notes (BK-002), spelled out in the file because both bite silently:
 * `minimumReleaseAgeExclude` is evaluated first-match-wins BY PACKAGE NAME, so
 * per-version exclusions of one package must be a single `||` union entry; and
 * `verifyDepsBeforeRun` defaults to `install`, so any `pnpm <script>` may run
 * `pnpm install` first — `warn` is offered commented out, never set for you.
 */
export function pnpmWorkspaceYaml(options: ProjectOptions): string {
  return `${
    options.ui
      ? `packages:
  - web
`
      : ''
  }allowBuilds:
  esbuild: true
  msgpackr-extract: false
# @basaltkit/* releases in lockstep, often within hours — exclude the scope from
# pnpm's minimumReleaseAge policy so \`pnpm up\` is never blocked on a fresh release.
minimumReleaseAgeExclude:
  - '@basaltkit/*'
# To let specific versions of ONE package bypass the policy, write ONE entry
# with a \`||\` union. pnpm evaluates this list first match wins by package
# name, so a second '<name>@<version>' entry for the same package is ignored:
#   - '@types/node@22.20.4 || 26.6.2'

# pnpm 11 checks dependencies before every \`pnpm <script>\` / \`pnpm exec\`
# (verifyDepsBeforeRun defaults to \`install\`): when node_modules is out of sync
# with ANY workspace project's manifest, it runs \`pnpm install\` first — network
# and supply-chain checks included. To opt out consciously (you then run
# \`pnpm install\` yourself after dependency changes), uncomment:
# verifyDepsBeforeRun: warn
`
}
