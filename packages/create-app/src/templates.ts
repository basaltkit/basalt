export interface ProjectOptions {
  name: string
  tenancy: boolean
  auth: boolean
  billing: boolean
  /** Scaffold a web/ frontend (React + shadcn + SDK). */
  ui: boolean
  /** Scaffold the `basalt` CLI entrypoint (code generators + built-in commands). */
  cli: boolean
}

/** Base release line for @basaltkit/* deps. */
const BASALT_VERSION = '^1.0.0'

/**
 * Per-package range overrides. In semver 0.x, `^0.4.0` locks the minor, so a
 * package that advances past the base line needs its own range or a fresh app
 * can't install it. Add an entry when a package crosses a minor.
 */
const VERSIONS: Record<string, string> = {}

/** The dependency range for a @basalt package (override, else the base line). */
export const versionOf = (pkg: string): string => VERSIONS[pkg] ?? BASALT_VERSION

export function packageJson(options: ProjectOptions): string {
  const dependencies: Record<string, string> = {
    '@basaltkit/config': BASALT_VERSION,
    '@basaltkit/core': BASALT_VERSION,
    '@basaltkit/env': BASALT_VERSION,
    '@basaltkit/events': BASALT_VERSION,
    '@basaltkit/fastify': BASALT_VERSION,
    '@basaltkit/logger': BASALT_VERSION,
    zod: '^4.0.0',
  }
  if (options.tenancy) dependencies['@basaltkit/tenancy'] = BASALT_VERSION
  if (options.auth) dependencies['@basaltkit/auth'] = BASALT_VERSION
  if (options.billing) dependencies['@basaltkit/subscriptions'] = BASALT_VERSION
  if (options.cli) {
    // Runtime deps: app.ts uses commandsPlugin (@basaltkit/cli); prisma powers
    // prismaPlugin + `basalt prisma:sync`. @basaltkit/generator is dev-only (below).
    dependencies['@basaltkit/cli'] = BASALT_VERSION
    dependencies['@basaltkit/prisma'] = BASALT_VERSION
  }
  // Apply per-package range overrides. Only @basaltkit/* packages: versionOf
  // falls back to BASALT_VERSION, which would clobber third-party ranges
  // (this once rewrote zod's range to the @basalt base line).
  for (const pkg of Object.keys(dependencies)) {
    if (pkg.startsWith('@basaltkit/')) dependencies[pkg] = versionOf(pkg)
  }

  const devDependencies: Record<string, string> = {
    '@basaltkit/testing': versionOf('@basaltkit/testing'),
    '@types/node': '^22.15.0',
    'pino-pretty': '^13.0.0',
    tsx: '^4.19.0',
    typescript: '^5.8.0',
    vitest: '^3.1.0',
  }
  if (options.cli) {
    // Dev-only: only bin/basalt.ts imports the code generator — the runtime server
    // never does, so the app runs completely without the codegen/AI layer.
    devDependencies['@basaltkit/generator'] = versionOf('@basaltkit/generator')
  }

  return `${JSON.stringify(
    {
      name: options.name,
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: {
        dev: 'tsx watch src/server.ts',
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
  return `import { defineEnv } from '@basaltkit/env'
import { z } from 'zod'

export const env = defineEnv({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),${
    options.auth
      ? `
  APP_SECRET: z.string().min(16).default('change-me-in-production--'),`
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
${options.auth ? 'APP_SECRET=change-me-in-production--\n' : ''}`
}

export function appTs(options: ProjectOptions): string {
  const imports = [
    `import { createApp } from '@basaltkit/core'`,
    `import { configPlugin } from '@basaltkit/config'`,
    `import { eventsPlugin } from '@basaltkit/events'`,
    `import { fastifyPlugin } from '@basaltkit/fastify'`,
    `import { loggerPlugin } from '@basaltkit/logger'`,
  ]
  const plugins = [
    `configPlugin({ app: { name: '${options.name}' } })`,
    `loggerPlugin({ level: options.logLevel ?? 'info', ...(options.pretty ? { pretty: true } : {}) })`,
    `eventsPlugin()`,
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
  plugins.push(`fastifyPlugin({ routes: ${routesExpression} })`)

  const commandsField = options.cli
    ? `\n  /** Dev/CLI commands (make:*, ai:*, prisma:sync) — passed ONLY by bin/basalt.ts. */\n  commands?: CommandDefinition[]`
    : ''

  return `${imports.join('\n')}
import { appRoutes } from './routes.js'

export interface BuildAppOptions {
  logLevel?: string
  pretty?: boolean${commandsField}
}

export function buildApp(options: BuildAppOptions = {}) {
  return createApp({
    plugins: [
      ${plugins.join(',\n      ')},
    ],
  })
}
`
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
  return `import { ctx } from '@basaltkit/core'
import { route } from '@basaltkit/fastify'

export const appRoutes = [
  // Friendly index so \`GET /\` is never a bare 404 — lists what the API exposes.
  route({
    method: 'GET',
    url: '/',
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
    url: '/health',
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

export function basaltBin(): string {
  return `#!/usr/bin/env node
import { runCli } from '@basaltkit/cli'
import { generatorCommands } from '@basaltkit/generator'
import { prismaSyncCommand } from '@basaltkit/prisma'
import { buildApp } from '../src/app.js'

// The 'basalt' CLI: boots the app WITH the dev/CLI commands, runs one, shuts down.
// The dev tools (@basaltkit/generator; add @basaltkit/ai for ai:*) are imported
// ONLY here — the runtime server (src/server.ts) never loads them, so the SaaS
// runs without the codegen/AI layer.
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
  ]
  return `# ${options.name}

A SaaS app scaffolded with [Basalt](https://github.com/Zebedeu/basalt).

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
}`
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
