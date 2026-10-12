import { describe, expect, it } from 'vitest'
import { dockerInfra } from '../src/config.js'
import { applyInfra, maintainServices, planInfra, renderCompose } from '../src/infra.js'
import { context, FakeHost, fail, lexfirmaConfig, ok } from './fake-host.js'

const config = () => lexfirmaConfig({
  infra: dockerInfra('lexfirma', {
    postgres: { urlParams: { schema: 'public' } },
    minio: { buckets: ['lexfirma-documents', 'lexfirma-backups'] },
  }),
})

const inspectOutput = (env: string[], ports: Record<string, string>) =>
  ok(`${JSON.stringify(env)}\t${JSON.stringify(Object.fromEntries(Object.entries(ports).map(([k, v]) => [k, [{ HostIp: '127.0.0.1', HostPort: v }]])))}`)

describe('dedicated infra', () => {
  it('adopts running containers: their credentials and ports win over the .env (incident 7)', async () => {
    const host = new FakeHost()
      .on(({ command, args }) => {
        if (command !== 'docker' || args[0] !== 'inspect') return undefined
        if (args[1] === 'lexfirma-pg') return inspectOutput(['POSTGRES_PASSWORD=pg-in-volume', 'POSTGRES_USER=lexfirma', 'POSTGRES_DB=lexfirma'], { '5432/tcp': '5434' })
        if (args[1] === 'lexfirma-redis') return inspectOutput(['REDIS_PASSWORD=redis-pw'], { '6379/tcp': '6381' })
        if (args[1] === 'lexfirma-minio') return inspectOutput(['MINIO_ROOT_USER=lexfirma', 'MINIO_ROOT_PASSWORD=minio-pw'], { '9000/tcp': '9110', '9001/tcp': '9111' })
        return undefined
      })
      .on(({ command }) => (command === 'ss' ? ok('') : undefined))
    const values = new Map([['DATABASE_URL', 'postgresql://lexfirma:FRESH@localhost:5434/lexfirma?schema=public']])
    const plan = await planInfra(context(host, config()), values)

    expect(plan.findings).toEqual([])
    expect(plan.services.map((s) => `${s.service}:${s.action}:${s.port}:${s.source}`)).toEqual([
      'postgres:adopt:5434:container', 'redis:adopt:6381:container', 'minio:adopt:9110:container',
    ])
    expect(Object.fromEntries(plan.env.map((c) => [c.key, c.kind === 'set' ? c.value : '']))).toEqual({
      DATABASE_URL: 'postgresql://lexfirma:pg-in-volume@127.0.0.1:5434/lexfirma?schema=public',
      REDIS_URL: 'redis://:redis-pw@127.0.0.1:6381',
      S3_ENDPOINT: 'http://127.0.0.1:9110',
      S3_ACCESS_KEY: 'lexfirma',
      S3_SECRET_KEY: 'minio-pw',
    })
    expect(plan.env[0]?.reason).toBe('from the running lexfirma-pg')
  })

  it('C7: a volume with no container and no known password is an error, never a fresh password', async () => {
    const host = new FakeHost()
      .on(({ command, args }) => (command === 'docker' && args[0] === 'inspect' ? fail('No such object') : undefined))
      .on(({ command, args }) => (command === 'docker' && args[0] === 'volume' ? (args[2] === 'lexfirma_lexfirma-pg-data' ? ok() : fail()) : undefined))
      .on(({ command }) => (command === 'ss' ? ok('') : undefined))
    const plan = await planInfra(context(host, config()), new Map())
    expect(plan.findings).toEqual([expect.objectContaining({ id: 'C7', level: 'error', message: expect.stringContaining('lexfirma_lexfirma-pg-data') })])
  })

  it('creates on free loopback ports when nothing exists', async () => {
    const host = new FakeHost()
      .on(({ command, args }) => (command === 'docker' && (args[0] === 'inspect' || args[0] === 'volume') ? fail() : undefined))
      .on(({ command }) => (command === 'ss' ? ok('LISTEN 0 511 127.0.0.1:5433 0.0.0.0:*') : undefined))
    const plan = await planInfra(context(host, config()), new Map())
    expect(plan.services.map((s) => `${s.service}:${s.action}:${s.port}`)).toEqual(['postgres:create:5434', 'redis:create:6380', 'minio:create:9100'])
    expect(plan.services[2]?.consolePort).toBe(9101)
  })

  it('no secret is ever in the compose file or on a command line', async () => {
    const host = new FakeHost()
      .on(({ command, args }) => (command === 'docker' && args[0] === 'inspect' ? fail() : undefined))
      .on(({ command, args }) => (command === 'docker' && args[0] === 'volume' ? fail() : undefined))
      .on(({ command, args }) => (command === 'docker' && args.includes('psql') ? ok('1\n') : undefined))
      .on(({ command, args }) => (command === 'docker' && args.includes('redis-cli') ? ok('PONG\n') : undefined))
      .on(({ command }) => (command === 'docker' ? ok() : undefined))
      .on(({ command }) => (command === 'ss' ? ok('') : undefined))
    const ctx = context(host, config())
    const plan = await planInfra(ctx, new Map())
    expect(await applyInfra(ctx, plan)).toEqual([])
    expect(await maintainServices(ctx, plan, new Map())).toEqual(['buckets: lexfirma-documents, lexfirma-backups'])

    const secrets = Object.values(plan.secrets).filter((v) => v !== 'lexfirma')
    const compose = host.file(`${ctx.stateDir}/infra.compose.yml`) ?? ''
    expect(compose).toContain("ports: ['127.0.0.1:")
    expect(compose).toContain('labels: { basalt.app: lexfirma }')
    const argv = host.calls.map((c) => c.args.join(' ')).join('\n')
    for (const secret of secrets) {
      expect(compose).not.toContain(secret)
      expect(argv).not.toContain(secret)
    }
    expect(host.mode(`${ctx.stateDir}/infra.compose.yml`)).toBe(0o600)
    expect(host.commands('docker')).toContain('docker exec -e MC_HOST_local lexfirma-minio mc mb -p local/lexfirma-documents local/lexfirma-backups')
  })

  it('C7: postgres refusing the password after start is reported with the safe fix', async () => {
    const host = new FakeHost()
      .on(({ command, args }) => (command === 'docker' && args.includes('psql') ? fail('password authentication failed') : undefined))
      .on(({ command, args }) => (command === 'docker' && args[0] === 'inspect' ? fail() : undefined))
      .on(({ command, args }) => (command === 'docker' && args[0] === 'volume' ? fail() : undefined))
      .on(({ command }) => (command === 'docker' ? ok('PONG') : undefined))
      .on(({ command }) => (command === 'ss' ? ok('') : undefined))
    const ctx = context(host, lexfirmaConfig({ infra: dockerInfra('lexfirma', { redis: false }) }))
    const plan = await planInfra(ctx, new Map([['DATABASE_URL', 'postgresql://lexfirma:wrong@127.0.0.1:5434/lexfirma']]))
    const findings = await applyInfra(ctx, plan)
    expect(findings).toEqual([expect.objectContaining({ id: 'C7', fix: expect.stringContaining('never re-create the volume') })])
  })

  it('refuses to write a user name that is not an identifier into the YAML', () => {
    const infra = dockerInfra('lexfirma')
    expect(() => renderCompose('lexfirma', infra, {
      services: [{ service: 'postgres', container: 'lexfirma-pg', volume: 'lexfirma_lexfirma-pg-data', action: 'adopt', port: 5434, user: 'x\n  privileged: true', database: 'lexfirma', source: 'container' }],
      env: [], findings: [], secrets: {},
    })).toThrow(/not a plain user\/database name/)
  })
})
