/**
 * RFC 0007 §2: `defineDeploy<typeof env>` types every `.env` key the config
 * names. The `@ts-expect-error` lines are the test — `tsc` (pnpm typecheck)
 * fails when one of them stops being an error.
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import { check } from '../src/check.js'
import { apache, compose, defineDeploy, dockerInfra, pm2, secret, validateConfig, type EnvValue } from '../src/index.js'
import { DIR, FakeHost, fail, ok } from './fake-host.js'

/** What `defineEnv({ … })` returns for a typical app. */
interface AppEnv {
  NODE_ENV: 'development' | 'production' | 'test'
  PORT: number
  DEBUG: boolean
  APP_SECRET: string
  DATABASE_URL: string
  OWNER_DATABASE_URL: string
  REDIS_URL: string
  SMTP_URL?: string | undefined
}

describe('the typed config', () => {
  it('values follow the schema: enum members, digits, true/false, else any string', () => {
    expectTypeOf<EnvValue<AppEnv['NODE_ENV']>>().toEqualTypeOf<'development' | 'production' | 'test'>()
    expectTypeOf<EnvValue<AppEnv['PORT']>>().toEqualTypeOf<`${number}`>()
    expectTypeOf<EnvValue<AppEnv['DEBUG']>>().toEqualTypeOf<'true' | 'false'>()
    expectTypeOf<EnvValue<AppEnv['SMTP_URL']>>().toEqualTypeOf<string>()
    expectTypeOf<EnvValue<unknown>>().toEqualTypeOf<string>()
  })

  it('accepts a config that names only the app\'s keys, with the helpers', () => {
    const config = defineDeploy<AppEnv>({
      app: 'acme',
      domain: 'acme.example.ao',
      env: {
        schema: 'src/env.ts',
        fixed: { NODE_ENV: 'production', PORT: '3000', DEBUG: 'false' },
        generate: { APP_SECRET: secret(32) },
        derive: ({ domain }) => ({ SMTP_URL: `smtp://mail.${domain}:587` }),
        forbid: ['LEGACY_FLAG'],
      },
      infra: dockerInfra('acme', { postgres: { urlKey: 'DATABASE_URL' }, redis: { urlKey: 'REDIS_URL' } }),
      migrate: { command: ['pnpm', 'db:deploy'], env: (values) => ({ DATABASE_URL: values.get('OWNER_DATABASE_URL') ?? '' }) },
      backup: { urlKey: 'OWNER_DATABASE_URL' },
      runtime: pm2({ avoid: [3000] }),
      proxy: apache(),
      health: { path: '/readyz' },
    })
    expect(validateConfig(config).app).toBe('acme')
  })

  it('refuses keys the app does not have, and values its schema does not allow', () => {
    defineDeploy<AppEnv>({
      app: 'acme', domain: 'acme.example.ao', runtime: pm2(),
      env: {
        // @ts-expect-error — not a NODE_ENV the schema accepts
        fixed: { NODE_ENV: 'prod' },
        // @ts-expect-error — a typo in a key
        generate: { APP_SECRT: secret(32) },
      },
      // @ts-expect-error — not a key of the app's env
      backup: { urlKey: 'DATABSE_URL' },
    })
    defineDeploy<AppEnv>({
      app: 'acme', domain: 'acme.example.ao', runtime: pm2(), env: {},
      // @ts-expect-error — the infra helper is typed by the same env
      infra: dockerInfra('acme', { postgres: { urlKey: 'PG_URL' } }),
      // @ts-expect-error — a health path starts with /
      health: { path: 'readyz' },
    })
    defineDeploy<AppEnv>({
      app: 'acme', domain: 'acme.example.ao', runtime: pm2(), env: {},
      // @ts-expect-error — migrate.env returns app keys only
      migrate: { env: () => ({ DB_URL: 'x' }) },
    })
  })

  it('without the env type every key is a string, as before', () => {
    const config = defineDeploy({
      app: 'acme', domain: 'acme.example.ao', env: { fixed: { ANYTHING: 'x' } },
      runtime: compose({ file: 'compose.yml', images: [{ tag: 'acme', dockerfile: 'Dockerfile', env: 'ACME_IMAGE' }], upstream: { service: 'api', port: 3001 } }),
      backup: { urlKey: 'WHATEVER_URL' },
    })
    expect(config.env.fixed).toEqual({ ANYTHING: 'x' })
  })
})

describe('basalt-deploy check', () => {
  const config = validateConfig(defineDeploy({ app: 'acme', domain: 'acme.example.ao', env: {}, runtime: pm2() }))
  const tsc = `${DIR}/node_modules/.bin/tsc`

  it('types the config with the app\'s tsc and tsconfig, this file as the only root, and cleans up', async () => {
    const host = new FakeHost().put(tsc, '', 0o755).put(`${DIR}/tsconfig.json`, '{}')
      .on(({ command }) => (command === tsc ? ok() : undefined))
    expect(await check(host, DIR, 'deploy.config.ts', config)).toBe(0)
    const call = host.calls.find((c) => c.command === tsc)
    const project = call?.args[1] as string
    expect(project.startsWith(`${DIR}/node_modules/.cache/basalt-deploy-check-`)).toBe(true)
    expect(host.file(project)).toBeUndefined()
    expect(host.printed).toContain('OK deploy.config.ts: types check')
  })

  it('prints tsc\'s errors relative to the app and fails', async () => {
    const host = new FakeHost().put(tsc, '', 0o755)
      .on(({ command }) => (command === tsc ? { ...fail('', 2), stdout: `${DIR}/deploy.config.ts(5,3): error TS2322: Type '"prod"' is not assignable\n` } : undefined))
    expect(await check(host, DIR, 'deploy.config.ts', config)).toBe(1)
    expect(host.transcript).toContain(`deploy.config.ts(5,3): error TS2322`)
    expect(host.transcript).not.toContain(`${DIR}/deploy.config.ts`)
  })

  it('without typescript in the app it validates only, and says so', async () => {
    const host = new FakeHost()
    expect(await check(host, DIR, 'deploy.config.ts', config)).toBe(0)
    expect(host.transcript).toContain('types not checked')
    expect(await check(host, DIR, 'deploy.config.mjs', config)).toBe(0)
  })
})
