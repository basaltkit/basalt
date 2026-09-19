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
    // prismaPlugin + `basalt prisma:sync`. @basaltkit/generator is dev-only (below).
    basalt.push('@basaltkit/cli', '@basaltkit/prisma')
  }
  const dependencies: Record<string, string> = { zod: thirdPartyVersionOf('zod') }
  for (const pkg of basalt) dependencies[pkg] = versionOf(pkg)

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
      },
      dependencies: Object.fromEntries(Object.entries(dependencies).sort()),
      devDependencies: Object.fromEntries(Object.entries(devDependencies).sort()),
    },
    null,
    2,
  )}\n`
}

export function tsconfigJson(): string {
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
      include: ['src', 'tests'],
    },
    null,
    2,
  )}\n`
}

export function envTs(options: ProjectOptions): string {
  return `import { defineEnv${options.auth ? ', secret' : ''} } from '@basaltkit/env'
import { LOG_LEVELS } from '@basaltkit/logger'
import { z } from 'zod'

export const env = defineEnv({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  // Typed against the logger's LogLevel union — a free-form string here fails
  // \`pnpm typecheck\` where loggerPlugin({ level }) consumes it.
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  // Unset counts as production (fail-closed); \`pnpm dev\` sets development.
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),${
    options.auth
      ? `
  // Signs JWTs and sessions. secret() is fail-closed: required unless NODE_ENV
  // is explicitly development/test (no fallback when NODE_ENV is unset),
  // rejected if it looks like a placeholder. \`pnpm dev\` uses devDefault.
  APP_SECRET: secret({ minLength: 32, devDefault: 'dev-only-insecure-secret-please-change-me' }),`
      : ''
  }
})
`
}

export function envExample(options: ProjectOptions): string {
  return `PORT=3000
HOST=0.0.0.0
LOG_LEVEL=info
NODE_ENV=development
${options.auth ? '# Required unless NODE_ENV is development/test — `pnpm start` refuses to boot\n# without it. Generate a strong one:  openssl rand -base64 48\n# APP_SECRET=\n' : ''}`
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

  if (options.tenancy) {
    imports.push(
      `import { headerResolver, MemoryTenantSource, subdomainResolver, tenancyPlugin } from '@basaltkit/tenancy'`,
    )
    plugins.push(`tenancyPlugin({
      // Replace MemoryTenantSource with your database-backed source.
      source: new MemoryTenantSource().add({ id: 'demo', name: 'Demo Tenant' }),
      resolvers: [headerResolver(), subdomainResolver({ base: 'localhost' })],
    })`)
  }
  if (options.auth) {
    imports.push(`import { authPlugin, authRoutes, mfaRoutes, MemoryUserSource } from '@basaltkit/auth'`)
    imports.push(`import { env } from './env.js'`)
    plugins.push(`authPlugin({
      // Replace MemoryUserSource with your database-backed source (e.g.
      // @basaltkit/auth-sqlite or @basaltkit/auth-prisma). The default in-memory
      // MFA store is enough for the ready-made TOTP flow below.
      users: new MemoryUserSource(),
      secret: env.APP_SECRET,
    })`)
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
    plugins.push(`teamsPlugin({
      // TODO: the default membership/invitation stores are in-memory — pass
      // persistent ones (memberships, invitations) before production.
    })`)
    plugins.push(`// Rejects authenticated requests for a tenant the user is not a member of.
      tenantMembershipPlugin()`)
    plugins.push(`// Dev-only seed: each new registrant joins the 'demo' tenant so the scaffold
      // works out of the box. Never in production — add members explicitly there
      // (on tenant creation, or via TEAMS invite()/accept()).
      ...(env.NODE_ENV === 'production' ? [] : [demoMembershipSeed()])`)
  }
  if (options.billing) {
    imports.push(`import { definePlans, subscriptionsPlugin } from '@basaltkit/subscriptions'`)
    plugins.push(`subscriptionsPlugin({
      plans: definePlans({
        free: { price: 0, features: { projects: 3 } },
        pro: { price: { monthly: 29, yearly: 290 }, trial: '14d', features: { projects: 50 } },
      }),
      fallbackPlan: 'free',
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

export function appTest(options: ProjectOptions): string {
  return `import { describe, expect, it } from 'vitest'
import { FASTIFY } from '@basaltkit/fastify'
import { buildApp } from '../src/app.js'

describe('app', () => {
  it('boots and responds on /health', async () => {
    const app = await buildApp({ logLevel: 'silent' }).boot()
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
pnpm install
pnpm dev        # API on http://localhost:3000
pnpm test
\`\`\`
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

export function gitignore(): string {
  return `node_modules/
dist/
.env
.env.*
!.env.example
*.log
`
}

/**
 * pnpm settings: esbuild's build script is required by tsx;
 * msgpackr-extract (optional native accelerator via BullMQ) is declined —
 * msgpackr falls back to pure JS. With --ui, `web` is a workspace member so
 * its own dependencies resolve.
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
`
}
