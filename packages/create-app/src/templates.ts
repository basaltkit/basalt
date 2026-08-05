export interface ProjectOptions {
  name: string
  tenancy: boolean
  auth: boolean
  billing: boolean
  /** Scaffold a web/ frontend (React + shadcn + SDK). */
  ui: boolean
  /** Scaffold the `mach` CLI entrypoint (code generators + built-in commands). */
  cli: boolean
}

/** Base release line for @machize/* deps. */
const MACHIZE_VERSION = '^0.1.0'

/**
 * Per-package range overrides. In semver 0.x, `^0.1.0` locks the minor, so a
 * package that has advanced to 0.2+ needs its own range or a fresh app can't
 * install it. Add an entry when a package crosses a minor.
 */
const VERSIONS: Record<string, string> = {
  '@machize/generator': '^0.2.0',
}

/** The dependency range for a @machize package (override, else the base line). */
export const versionOf = (pkg: string): string => VERSIONS[pkg] ?? MACHIZE_VERSION

export function packageJson(options: ProjectOptions): string {
  const dependencies: Record<string, string> = {
    '@machize/config': MACHIZE_VERSION,
    '@machize/core': MACHIZE_VERSION,
    '@machize/env': MACHIZE_VERSION,
    '@machize/events': MACHIZE_VERSION,
    '@machize/fastify': MACHIZE_VERSION,
    '@machize/logger': MACHIZE_VERSION,
    zod: '^3.24.0',
  }
  if (options.tenancy) dependencies['@machize/tenancy'] = MACHIZE_VERSION
  if (options.auth) dependencies['@machize/auth'] = MACHIZE_VERSION
  if (options.billing) dependencies['@machize/subscriptions'] = MACHIZE_VERSION
  if (options.cli) {
    dependencies['@machize/cli'] = MACHIZE_VERSION
    dependencies['@machize/generator'] = MACHIZE_VERSION
  }
  // Apply per-package range overrides (packages past the 0.1 line).
  for (const pkg of Object.keys(dependencies)) {
    dependencies[pkg] = versionOf(pkg)
  }

  return `${JSON.stringify(
    {
      name: options.name,
      private: true,
      type: 'module',
      scripts: {
        dev: 'tsx watch src/server.ts',
        start: 'tsx src/server.ts',
        test: 'vitest run',
        typecheck: 'tsc --noEmit',
        ...(options.cli ? { mach: 'tsx bin/mach.ts' } : {}),
      },
      dependencies: Object.fromEntries(Object.entries(dependencies).sort()),
      devDependencies: {
        '@machize/testing': MACHIZE_VERSION,
        '@types/node': '^22.15.0',
        'pino-pretty': '^13.0.0',
        tsx: '^4.19.0',
        typescript: '^5.8.0',
        vitest: '^3.1.0',
      },
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
  return `import { defineEnv } from '@machize/env'
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
    `import { createApp } from '@machize/core'`,
    `import { configPlugin } from '@machize/config'`,
    `import { eventsPlugin } from '@machize/events'`,
    `import { fastifyPlugin } from '@machize/fastify'`,
    `import { loggerPlugin } from '@machize/logger'`,
  ]
  const plugins = [
    `configPlugin({ app: { name: '${options.name}' } })`,
    `loggerPlugin({ level: options.logLevel ?? 'info', ...(options.pretty ? { pretty: true } : {}) })`,
    `eventsPlugin()`,
  ]
  let routesExpression = 'appRoutes'

  if (options.tenancy) {
    imports.push(
      `import { headerResolver, MemoryTenantSource, subdomainResolver, tenancyPlugin } from '@machize/tenancy'`,
    )
    plugins.push(`tenancyPlugin({
      // Replace MemoryTenantSource with your database-backed source.
      source: new MemoryTenantSource().add({ id: 'demo', name: 'Demo Tenant' }),
      resolvers: [headerResolver(), subdomainResolver({ base: 'localhost' })],
    })`)
  }
  if (options.auth) {
    imports.push(`import { authPlugin, authRoutes, MemoryUserSource } from '@machize/auth'`)
    imports.push(`import { env } from './env.js'`)
    plugins.push(`authPlugin({
      // Replace MemoryUserSource with your database-backed source.
      users: new MemoryUserSource(),
      secret: env.APP_SECRET,
    })`)
    routesExpression = '[...appRoutes, ...authRoutes()]'
  }
  if (options.billing) {
    imports.push(`import { definePlans, subscriptionsPlugin } from '@machize/subscriptions'`)
    plugins.push(`subscriptionsPlugin({
      plans: definePlans({
        free: { price: 0, features: { projects: 3 } },
        pro: { price: { monthly: 29, yearly: 290 }, trial: '14d', features: { projects: 50 } },
      }),
      fallbackPlan: 'free',
    })`)
  }
  if (options.cli) {
    imports.push(`import { commandsPlugin } from '@machize/cli'`)
    imports.push(`import { generatorCommands } from '@machize/generator'`)
    // Registers \`mach make:*\` generators; built-ins (routes, schedule:list) come free.
    plugins.push(`commandsPlugin(generatorCommands())`)
  }
  plugins.push(`fastifyPlugin({ routes: ${routesExpression} })`)

  return `${imports.join('\n')}
import { appRoutes } from './routes.js'

export interface BuildAppOptions {
  logLevel?: string
  pretty?: boolean
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
  return `import { ctx } from '@machize/core'
import { route } from '@machize/fastify'

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
  return `import { FASTIFY } from '@machize/fastify'
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

export function machBin(): string {
  return `#!/usr/bin/env node
import { runCli } from '@machize/cli'
import { buildApp } from '../src/app.js'

// The 'mach' CLI: boots the app, runs one command, shuts down.
//   pnpm mach list                    — show available commands
//   pnpm mach routes                  — list registered HTTP routes
//   pnpm mach make:resource Project   — generate a full resource vertical
//   pnpm mach make:service Project    — generate a single artifact (schema/service/…)
const app = buildApp({ logLevel: 'silent' })
process.exit(await runCli({ app }))
`
}

export function appTest(options: ProjectOptions): string {
  return `import { describe, expect, it } from 'vitest'
import { FASTIFY } from '@machize/fastify'
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
    ...(options.ui ? ['web UI (React + shadcn/ui on @machize/admin-shadcn + @machize/sdk)'] : []),
    ...(options.cli ? ['`mach` CLI with code generators (`make:*`) and built-in commands'] : []),
  ]
  return `# ${options.name}

A SaaS app scaffolded with [Machize](https://github.com/Zebedeu/machize).

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
## The \`mach\` CLI

\`\`\`bash
pnpm mach list                    # available commands
pnpm mach routes                  # registered HTTP routes
pnpm mach make:resource Project   # schema → repository → service → plugin → routes → test
pnpm mach make:service Project    # a single artifact (--force to overwrite)
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
`
}
