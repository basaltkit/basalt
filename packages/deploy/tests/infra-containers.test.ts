/**
 * 0.4.0: dedicated infra for an app that runs in compose — its own compose
 * project, URLs that name the containers, the host form for what runs on the
 * host, the app role following a recreated database, passEnv.
 */
import { describe, expect, it } from 'vitest'
import { composeEnv } from '../src/compose.js'
import { compose, DeployConfigError, dockerInfra, validateConfig, type DeployConfig } from '../src/config.js'
import type { DeployContext } from '../src/context.js'
import { planInfra, renderCompose } from '../src/infra.js'
import { migrationValues } from '../src/pipeline.js'
import { appRoleEnv } from '../src/services.js'
import { FakeHost, fail, ok } from './fake-host.js'

const DIR = '/srv/globex'

function globex(extra: Partial<DeployConfig> = {}): DeployConfig {
  return {
    app: 'globex',
    domain: 'globex.example.com',
    env: { file: '/etc/globex/api.env' },
    infra: dockerInfra('globex', {
      project: 'globex-infra',
      access: 'containers',
      postgres: { user: 'globex_owner', database: 'globex', urlKey: 'GLOBEX_OWNER_DATABASE_URL', appRole: { name: 'globex_app', urlKey: 'GLOBEX_DATABASE_URL' } },
      redis: { urlKey: 'GLOBEX_REDIS_URL' },
      minio: { buckets: ['globex-documents'], keys: { endpoint: 'GLOBEX_S3_ENDPOINT', accessKey: 'GLOBEX_S3_ACCESS_KEY_ID', secretKey: 'GLOBEX_S3_SECRET_ACCESS_KEY' } },
    }),
    runtime: compose({
      file: 'docker/compose.prod.yml',
      images: [{ tag: 'globex', dockerfile: 'docker/app/Dockerfile', env: 'GLOBEX_IMAGE' }],
      upstream: { service: 'api', port: 3001 },
      passEnv: ['GLOBEX_REDIS_URL'],
    }),
    ...extra,
  }
}

const ctxOf = (host: FakeHost, config = globex()): DeployContext => ({ config, dir: DIR, host, pm: 'pnpm', envPath: '/etc/globex/api.env', stateDir: `${DIR}/.basalt` })

/** A clean server: no container, no volume; ports from 5433 free. */
const clean = () => new FakeHost()
  .on(({ command, args }) => (command === 'docker' && (args[0] === 'inspect' || args[0] === 'volume') ? fail() : undefined))
  .on(({ command }) => (command === 'ss' ? ok('') : undefined))

describe('dedicated infra for a compose app', () => {
  it('URLs name the containers; the host gets 127.0.0.1 and the published port', async () => {
    const ctx = ctxOf(clean())
    const plan = await planInfra(ctx, new Map())
    const env = new Map(plan.env.map((c) => [c.key, c.kind === 'set' ? c.value : '']))
    expect(env.get('GLOBEX_OWNER_DATABASE_URL')).toMatch(/^postgresql:\/\/globex_owner:[0-9a-f]{48}@globex-pg:5432\/globex$/)
    expect(env.get('GLOBEX_DATABASE_URL')).toMatch(/^postgresql:\/\/globex_app:[0-9a-f]{48}@globex-pg:5432\/globex$/)
    expect(env.get('GLOBEX_REDIS_URL')).toMatch(/^redis:\/\/:[0-9a-f]{48}@globex-redis:6379$/)
    expect(env.get('GLOBEX_S3_ENDPOINT')).toBe('http://globex-minio:9000')
    expect(plan.hostUrls).toEqual([['globex-pg:5432', '127.0.0.1:5433'], ['globex-redis:6379', '127.0.0.1:6380'], ['globex-minio:9000', '127.0.0.1:9100']])

    const onHost = migrationValues(ctx.config, env, plan.hostUrls)
    expect(onHost.get('GLOBEX_OWNER_DATABASE_URL')).toMatch(/@127\.0\.0\.1:5433\/globex$/)
    expect(onHost.get('GLOBEX_DATABASE_URL')).toMatch(/@127\.0\.0\.1:5433\/globex$/)
    expect(onHost.get('GLOBEX_S3_ENDPOINT')).toBe('http://127.0.0.1:9100')
  })

  it('its own compose project and volumes, still bound to 127.0.0.1', async () => {
    const ctx = ctxOf(clean())
    const plan = await planInfra(ctx, new Map())
    const file = renderCompose('globex', ctx.config.infra as never, plan)
    expect(file).toContain('name: globex-infra')
    expect(plan.services.map((s) => s.volume)).toEqual(['globex-infra_globex-pg-data', 'globex-infra_globex-redis-data', 'globex-infra_globex-minio-data'])
    expect(file).toContain("volumes: ['globex-pg-data:/var/lib/postgresql/data']")
    expect(file).toContain("ports: ['127.0.0.1:5433:5432']")
  })

  it('a password already in the .env is kept when its URL names the container', async () => {
    const values = new Map([['GLOBEX_OWNER_DATABASE_URL', 'postgresql://globex_owner:kept@globex-pg:5432/globex']])
    const plan = await planInfra(ctxOf(clean()), values)
    expect(plan.secrets['BASALT_PG_PASSWORD']).toBe('kept')
    expect(plan.services[0]?.source).toBe('env')
  })

  it('the app role follows a recreated database and keeps its password', () => {
    const ctx = ctxOf(new FakeHost())
    const values = new Map([['GLOBEX_DATABASE_URL', 'postgresql://globex_app:apppw@old-postgres:5432/globex']])
    const [change] = appRoleEnv(ctx, values, 'postgresql://globex_owner:x@globex-pg:5432/globex')
    expect(change).toMatchObject({ kind: 'set', key: 'GLOBEX_DATABASE_URL', value: 'postgresql://globex_app:apppw@globex-pg:5432/globex' })
    expect(appRoleEnv(ctx, new Map([['GLOBEX_DATABASE_URL', 'postgresql://globex_app:apppw@globex-pg:5432/globex']]), 'postgresql://globex_owner:x@globex-pg:5432/globex')).toEqual([])
  })

  it('passEnv hands the .env value to compose, from memory only', () => {
    const ctx = ctxOf(new FakeHost())
    expect(composeEnv(ctx, 'b'.repeat(40))['GLOBEX_REDIS_URL']).toBeUndefined()
    ctx.values = new Map([['GLOBEX_REDIS_URL', 'redis://:pw@globex-redis:6379'], ['OTHER', 'x']])
    const env = composeEnv(ctx, 'b'.repeat(40))
    expect(env).toEqual({ GLOBEX_IMAGE: 'globex:bbbbbbb', GLOBEX_REDIS_URL: 'redis://:pw@globex-redis:6379' })
  })

  it('attach to the dedicated containers is not an error before the infra step creates them', async () => {
    const { composePreflight } = await import('../src/compose.js')
    const config = globex({
      runtime: compose({
        file: 'docker/compose.prod.yml',
        images: [{ tag: 'globex', dockerfile: 'docker/app/Dockerfile', env: 'GLOBEX_IMAGE' }],
        upstream: { service: 'api', port: 3001 },
        attach: { 'globex-pg': ['data'], 'globex-redis': ['data'], 'other-db': ['data'] },
      }),
    })
    const host = clean().put(`${DIR}/docker/compose.prod.yml`, 'services: {}\n')
      .on(({ command, args }) => (command === 'docker' && args.includes('--services') ? ok('api\n') : undefined))
      .on(({ command, args }) => (command === 'docker' && args.includes('config') ? ok() : undefined))
    const messages = (await composePreflight(ctxOf(host, config), 'b'.repeat(40))).map((f) => f.message)
    expect(messages).toEqual(['runtime.attach: other-db does not exist'])
  })

  it('a compose app cannot share its compose project with its infra', () => {
    const shared = globex({ infra: dockerInfra('globex', { access: 'containers' }) })
    expect(() => validateConfig(shared)).toThrow(DeployConfigError)
    expect(() => validateConfig(globex({ infra: dockerInfra('globex', { project: 'Globex Infra' }) }))).toThrow(/not a compose project name/)
    expect(validateConfig(globex()).app).toBe('globex')
  })
})
