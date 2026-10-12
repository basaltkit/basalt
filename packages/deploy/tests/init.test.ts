/**
 * RFC 0007 §3: `basalt-deploy init` writes deploy.config.ts from the project.
 * The fake projects mirror a create-basalt app and Mukanda.
 */
import { describe, expect, it } from 'vitest'
import { appName, detectProject, init, parseEnvSchema, renderConfig } from '../src/init.js'
import { FakeHost, fail, ok } from './fake-host.js'

const DIR = '/home/dev/acme'

const SCAFFOLD_ENV = `import { defineEnv, secret } from '@basaltkit/env'
import { z } from 'zod'

export const env = defineEnv(
  {
    PORT: z.coerce.number().default(3000),
    HOST: z.string().default('0.0.0.0'),
    // Unset counts as production (fail-closed)
    NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
    DATABASE_URL: z.string().min(1),
    /* signs sessions, { not a brace that counts } */
    APP_SECRET: secret({ minLength: 32, devDefault: 'dev-only, with a comma' }),
    SMTP_URL: z.string().url(),
    STRIPE_API_KEY: secret({ minLength: 10 }),
    FEATURE_X: z.coerce.boolean().optional(),
  },
  { prefix: 'ACME' },
)
`

function scaffold(readyz = false): FakeHost {
  return new FakeHost()
    .put(`${DIR}/package.json`, JSON.stringify({ name: '@acme/Acme App', scripts: { 'db:deploy': 'prisma migrate deploy' } }))
    .put(`${DIR}/src/env.ts`, SCAFFOLD_ENV)
    .put(`${DIR}/prisma.config.ts`, '')
    .on(({ command }) => (command === 'grep' ? (readyz ? ok('src/routes/health.ts\n') : fail('', 1)) : undefined))
}

const COMPOSE_JSON = JSON.stringify({
  services: {
    api: { image: '${ACME_IMAGE:?pinned}', ports: ['127.0.0.1:${ACME_API_HOST_PORT:-3001}:3000'] },
    worker: { image: '${ACME_IMAGE:?pinned}' },
    scanner: { image: '${ACME_SCANNER_IMAGE}', build: { context: `${DIR}/docker/scanner`, dockerfile: 'Dockerfile' } },
    ingest: { image: '${ACME_INGEST_IMAGE}' },
    postgres: { image: 'postgres:16' },
  },
})

function composed(): FakeHost {
  return scaffold(true)
    .put(`${DIR}/docker/compose.prod.yml`, '')
    .put(`${DIR}/docker/app/Dockerfile`, 'FROM node:24\nCOPY package.json pnpm-lock.yaml ./\n')
    .put(`${DIR}/docker/ingestion/Dockerfile`, 'FROM node:24\nCOPY --chown=node src ./src\n')
    .put(`${DIR}/web/package.json`, '{}')
    .on(({ command, args }) => (command === 'docker' && args.includes('config') ? ok(COMPOSE_JSON) : undefined))
}

describe('reading the project', () => {
  it('reads the keys of defineEnv as text: secrets, optionals, comments and strings ignored', () => {
    const parsed = parseEnvSchema(SCAFFOLD_ENV)
    expect(parsed?.exportName).toBe('env')
    expect(parsed?.keys).toEqual([
      { name: 'PORT', secret: false, optional: true },
      { name: 'HOST', secret: false, optional: true },
      { name: 'NODE_ENV', secret: false, optional: true },
      { name: 'DATABASE_URL', secret: false, optional: false },
      { name: 'APP_SECRET', secret: true, optional: false },
      { name: 'SMTP_URL', secret: false, optional: false },
      { name: 'STRIPE_API_KEY', secret: true, optional: false },
      { name: 'FEATURE_X', secret: false, optional: true },
    ])
    expect(parseEnvSchema('export const x = 1')).toBeUndefined()
  })

  it('names the app within C4', () => {
    expect(appName('@acme/Acme App')).toBe('acme-app')
    expect(appName('123-shop')).toBe('shop')
    expect(appName('42')).toBe('app')
    expect(appName('a'.repeat(50))).toHaveLength(31)
  })

  it('a compose file of infra only is not the runtime (LexFirma\'s postgres + redis)', async () => {
    const host = scaffold().put(`${DIR}/docker-compose.prod.yml`, '')
      .on(({ command }) => (command === 'docker' ? ok(JSON.stringify({ services: { postgres: { image: 'postgres:16' } } })) : undefined))
    expect((await detectProject(host, DIR)).compose).toBeUndefined()
  })

  it('compose: one image per variable, Dockerfile from build: or docker/<name>/, the 127.0.0.1 port as upstream', async () => {
    const facts = await detectProject(composed(), DIR)
    expect(facts.compose).toEqual({
      file: 'docker/compose.prod.yml',
      images: [
        { tag: 'acme-app', dockerfile: 'docker/app/Dockerfile', context: '.', env: 'ACME_IMAGE' },
        { tag: 'acme-app-scanner', dockerfile: 'docker/scanner/Dockerfile', context: 'docker/scanner', env: 'ACME_SCANNER_IMAGE' },
        { tag: 'acme-app-ingest', dockerfile: 'docker/ingestion/Dockerfile', context: '.', env: 'ACME_INGEST_IMAGE' },
      ],
      upstream: { service: 'api', port: 3001 },
      env: { ACME_API_HOST_PORT: '3001' },
    })
    expect(facts.health).toBe('/readyz')
    expect(facts.web).toBe('web')
  })

  it('an image without a Dockerfile it can find is an error that says where to put one', async () => {
    const host = composed().put(`${DIR}/docker/ingestion/Dockerfile`, '')
    host.files.delete(`${DIR}/docker/ingestion/Dockerfile`)
    await expect(detectProject(host, DIR)).rejects.toThrow(/no Dockerfile found for ACME_INGEST_IMAGE \(ingest\)/)
  })

  it('--server: the vhosts that already serve the domain, and the ports taken', async () => {
    const host = scaffold()
      .put('/etc/apache2/sites-available/acme.conf', '<VirtualHost *:443>\n  ServerName acme.example.ao\n  ServerAlias *.acme.example.ao\n')
      .put('/etc/apache2/sites-available/other.conf', 'ServerName other.example.ao\n')
      .on(({ command }) => (command === 'ss' ? ok('LISTEN 0 511 *:3000 *:*\nLISTEN 0 4096 127.0.0.1:3001 0.0.0.0:*\nLISTEN 0 4096 0.0.0.0:22 0.0.0.0:*\n') : undefined))
    expect((await detectProject(host, DIR, { server: 'acme.example.ao' })).server).toEqual({ vhosts: ['acme.conf'], busyPorts: [3000, 3001] })
  })
})

describe('the file', () => {
  it('a create-basalt app: pm2, dedicated Postgres, own secrets generated, issued ones asked', async () => {
    const source = renderConfig(await detectProject(scaffold(), DIR), { domain: 'acme.example.ao', tenants: 'none', branch: 'main', proxy: 'apache' })
    expect(source).toContain(`import type { env } from './src/env.js'`)
    expect(source).toContain('export default defineDeploy<typeof env>({')
    expect(source).toContain(`fixed: { NODE_ENV: 'production', HOST: '127.0.0.1' }`)
    expect(source).toContain('generate: { APP_SECRET: secret(32) }')
    expect(source).toContain(`SMTP_URL: ask.secret('SMTP URL')`)
    expect(source).toContain(`STRIPE_API_KEY: ask.secret('STRIPE API KEY')`)
    expect(source).not.toMatch(/DATABASE_URL|FEATURE_X|PORT:/)
    expect(source).toContain(`infra: dockerInfra('acme-app', { redis: false })`)
    expect(source).toContain(`migrate: { central: true }`)
    expect(source).toContain('runtime: pm2(),')
    expect(source).toContain(`health: { path: '/health' }`)
    expect(source).not.toContain('tenants:')
    expect(source).not.toContain('branch:')
  })

  it('a compose app (Mukanda\'s shape): images, upstream, its migration script, tenants, branch, server vhosts', async () => {
    const host = composed().put(`${DIR}/package.json`, JSON.stringify({ name: 'acme', scripts: { 'db:deploy': 'tsx scripts/db.ts deploy' } }))
    const facts = { ...(await detectProject(host, DIR)), server: { vhosts: ['acme-app.conf', 'acme-share.conf'], busyPorts: [] } }
    const source = renderConfig(facts, { domain: 'acme.example.ao', tenants: 'subdomain', branch: 'master', proxy: 'apache' })
    expect(source).toContain(`migrate: { command: ['pnpm', 'db:deploy'] }`)
    expect(source).toContain(`{ tag: 'acme', dockerfile: 'docker/app/Dockerfile', env: 'ACME_IMAGE' },`)
    expect(source).toContain(`context: 'docker/scanner'`)
    expect(source).toContain(`upstream: { service: 'api', port: 3001 },`)
    expect(source).toContain(`env: { ACME_API_HOST_PORT: '3001' },`)
    expect(source).toContain(`proxy: apache({ managed: false, vhosts: ['acme-app.conf', 'acme-share.conf'] })`)
    expect(source).toContain(`tenants: 'subdomain',`)
    expect(source).toContain(`branch: 'master',`)
    // Under compose the database is the compose file's business: asked, not dockerInfra.
    expect(source).not.toContain('dockerInfra')
    expect(source).toContain(`DATABASE_URL: ask.secret('DATABASE URL')`)
  })

  it('a compose file without a loopback port cannot be proxied: said, not guessed', async () => {
    const facts = await detectProject(composed(), DIR)
    expect(() => renderConfig({ ...facts, compose: { ...facts.compose!, upstream: undefined } }, { domain: 'a.example.ao', tenants: 'none', branch: 'main', proxy: 'none' }))
      .toThrow(/no service publishes a port on 127.0.0.1/)
  })

  it('without src/env.ts: untyped, the classic infra, no proxy when asked for none', async () => {
    const host = new FakeHost().put(`${DIR}/package.json`, '{"name":"plain"}').on(({ command }) => (command === 'grep' ? fail('', 2) : undefined))
    const source = renderConfig(await detectProject(host, DIR), { domain: 'plain.example.ao', tenants: 'none', branch: 'main', proxy: 'none' })
    expect(source).toContain('export default defineDeploy({')
    expect(source).not.toContain('import type')
    expect(source).toContain(`infra: dockerInfra('plain'),`)
    expect(source).not.toContain('proxy:')
  })
})

describe('the command', () => {
  const flags = (values: Record<string, string>) => new Map(Object.entries(values))

  it('writes the file once; --force replaces it', async () => {
    const host = scaffold()
    expect(await init(host, DIR, flags({ domain: 'acme.example.ao' }), new Set())).toBe(0)
    expect(host.file(`${DIR}/deploy.config.ts`)).toContain(`domain: 'acme.example.ao'`)
    expect(await init(host, DIR, flags({ domain: 'other.example.ao' }), new Set())).toBe(1)
    expect(host.transcript).toContain('init never overwrites it')
    expect(await init(host, DIR, flags({ domain: 'other.example.ao' }), new Set(['force']))).toBe(0)
    expect(host.file(`${DIR}/deploy.config.ts`)).toContain(`domain: 'other.example.ao'`)
  })

  it('without a terminal, the domain is a flag; bad answers are refused', async () => {
    expect(await init(scaffold(), DIR, flags({}), new Set())).toBe(1)
    expect(await init(scaffold(), DIR, flags({ domain: 'Not A Host' }), new Set())).toBe(1)
    expect(await init(scaffold(), DIR, flags({ domain: 'a.example.ao', tenants: 'yes' }), new Set())).toBe(1)
    expect(await init(scaffold(), DIR, flags({ domain: 'a.example.ao', proxy: 'nginx' }), new Set())).toBe(1)
  })

  it('with a terminal it asks, with defaults', async () => {
    const host = scaffold()
    host.interactive = () => true
    const answers = ['acme.example.ao', 'subdomain', '', '']
    host.prompt = async () => answers.shift()
    expect(await init(host, DIR, flags({}), new Set())).toBe(0)
    expect(host.file(`${DIR}/deploy.config.ts`)).toContain(`tenants: 'subdomain'`)
  })
})
