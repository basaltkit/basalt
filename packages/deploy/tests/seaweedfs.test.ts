/**
 * RFC 0010: SeaweedFS in place of MinIO, and the buckets over the S3 API
 * instead of MinIO's `mc`.
 */
import { describe, expect, it } from 'vitest'
import { DeployConfigError, dockerInfra, external, MINIO_REMOVED, validateConfig } from '../src/config.js'
import { planInfra, renderCompose } from '../src/infra.js'
import { ensureBuckets, hasExpiry, signedHeaders, withExpiryRule, type S3Target } from '../src/s3.js'
import { acmeConfig, context, FakeHost, fail, ok } from './fake-host.js'

const target: S3Target = { label: 'seaweedfs', endpoint: 'http://127.0.0.1:8333', accessKey: 'acme', secretKey: 'the-secret' }

describe('SigV4', () => {
  it('matches the S3 documentation\'s GET Object example', () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html — "Example: GET Object"
    const headers = signedHeaders(
      { label: 's3', endpoint: 'https://examplebucket.s3.amazonaws.com', accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
      { method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'), body: '', headers: { Range: 'bytes=0-9' } },
      new Date('2013-05-24T00:00:00Z'),
    )
    expect(headers.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
      + 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')
  })
})

describe('the lifecycle document', () => {
  it('an expiry counts only when enabled, for the whole bucket', () => {
    const rule = (inner: string) => `<LifecycleConfiguration><Rule>${inner}</Rule></LifecycleConfiguration>`
    expect(hasExpiry(rule('<Status>Enabled</Status><Filter><Prefix></Prefix></Filter><Expiration><Days>1</Days></Expiration>'), 1)).toBe(true)
    expect(hasExpiry(rule('<Status>Enabled</Status><Filter/><Expiration>\n  <Days>1</Days>\n</Expiration>'), 1)).toBe(true)
    expect(hasExpiry(rule('<Status>Enabled</Status><Filter><Prefix>tmp/</Prefix></Filter><Expiration><Days>1</Days></Expiration>'), 1)).toBe(false)
    expect(hasExpiry(rule('<Status>Disabled</Status><Filter><Prefix></Prefix></Filter><Expiration><Days>1</Days></Expiration>'), 1)).toBe(false)
    expect(hasExpiry(rule('<Status>Enabled</Status><Filter><Prefix></Prefix></Filter><Expiration><Days>10</Days></Expiration>'), 1)).toBe(false)
    expect(hasExpiry('', 1)).toBe(false)
  })

  it('a new rule is added next to the ones already there', () => {
    const existing = '<LifecycleConfiguration><Rule><ID>by-hand</ID></Rule></LifecycleConfiguration>'
    const next = withExpiryRule(existing, 3)
    expect(next).toContain('<ID>by-hand</ID>')
    expect(next).toContain('<ID>basalt-expire-3d</ID>')
    expect(hasExpiry(next, 3)).toBe(true)
    expect(hasExpiry(withExpiryRule('', 2), 2)).toBe(true)
  })
})

describe('buckets over the S3 API', () => {
  it('creates what is missing; a bucket already ours is not an error', async () => {
    const host = new FakeHost()
    host.respond = ({ method, url }) => {
      if (method === 'HEAD') return { status: 404 }
      if (url.endsWith('/raced')) return { status: 409, body: '<Error><Code>BucketAlreadyOwnedByYou</Code></Error>' }
      return { status: 200 }
    }
    expect(await ensureBuckets(context(host), target, ['fresh', 'raced'])).toBe('buckets: fresh, raced')
    expect(host.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(['HEAD /fresh', 'PUT /fresh', 'HEAD /raced', 'PUT /raced'])
  })

  it('refused credentials say so, with the store\'s code', async () => {
    const host = new FakeHost()
    host.respond = () => ({ status: 403, body: '<Error><Code>SignatureDoesNotMatch</Code></Error>' })
    await expect(ensureBuckets(context(host), target, ['docs'])).rejects.toThrow('seaweedfs: the credentials were refused checking docs (SignatureDoesNotMatch)')
  })

  it('a store that takes the expiry rule but does not keep it is an error, not a silent pass', async () => {
    const host = new FakeHost()
    // Accepts the PUT, then answers the GET as if there were no rule.
    host.respond = ({ url, method }) => (url.includes('lifecycle') && method === 'GET' ? { status: 404 } : { status: 200 })
    await expect(ensureBuckets(context(host), target, [{ name: 'q', expireDays: 1 }])).rejects.toThrow(/does not report it/)
  })

  it('an unreachable store names the address', async () => {
    const host = new FakeHost()
    host.respond = () => ({ error: 'connect ECONNREFUSED 127.0.0.1:8333' })
    await expect(ensureBuckets(context(host), target, ['docs'])).rejects.toThrow('seaweedfs: cannot reach http://127.0.0.1:8333 (connect ECONNREFUSED 127.0.0.1:8333)')
  })
})

const clean = () => new FakeHost()
  .on(({ command, args }) => (command === 'docker' && (args[0] === 'inspect' || args[0] === 'volume') ? fail() : undefined))
  .on(({ command }) => (command === 'ss' ? ok('') : undefined))

describe('the dedicated SeaweedFS', () => {
  const config = () => acmeConfig({ infra: dockerInfra('acme', { postgres: false, redis: false, seaweedfs: { buckets: ['acme-documents'] } }) })

  it('publishes only the S3 API, on 127.0.0.1; everything else stays inside the container', async () => {
    const ctx = context(clean(), config())
    const plan = await planInfra(ctx, new Map())
    const file = renderCompose('acme', ctx.config.infra as never, plan)
    expect(file).toContain("ports: ['127.0.0.1:8333:8333']")
    expect(file).toContain("'-ip.bind=127.0.0.1', '-s3.ip.bind=0.0.0.0', '-s3.port.iceberg=0', '-s3.port.lance=0'")
    // Not (free disk / 30 GB) volumes: with little disk, the second bucket could not write at all.
    expect(file).toContain("'-master.volumeSizeLimitMB=1024', '-volume.max=1000'")
    expect(file).toContain('WEED_JWT_FILER_SIGNING_KEY: ${BASALT_S3_SIGNING_KEY:?missing}')
    expect(file).toContain('image: chrislusf/seaweedfs:4.48')
    expect(file).toContain("volumes: ['acme-seaweedfs-data:/data']")
    for (const secret of Object.values(plan.secrets).filter((v) => v !== 'acme')) expect(file).not.toContain(secret)
  })

  it('a new store gets generated credentials and its own signing key', async () => {
    const plan = await planInfra(context(clean(), config()), new Map())
    expect(plan.services).toEqual([expect.objectContaining({ service: 'seaweedfs', container: 'acme-seaweedfs', action: 'create', port: 8333, source: 'generated' })])
    expect(plan.secrets['BASALT_S3_ACCESS_KEY']).toBe('acme')
    expect(plan.secrets['BASALT_S3_SECRET_KEY']).toMatch(/^[0-9a-f]{48}$/)
    expect(plan.secrets['BASALT_S3_SIGNING_KEY']).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.fromEntries(plan.env.map((c) => [c.key, c.kind === 'set' ? c.value : '']))).toMatchObject({ S3_ENDPOINT: 'http://127.0.0.1:8333', S3_ACCESS_KEY: 'acme' })
  })

  it('an old volume without its container is no error: the credentials are not in the data (unlike Postgres)', async () => {
    const host = new FakeHost()
      .on(({ command, args }) => (command === 'docker' && args[0] === 'inspect' ? fail() : undefined))
      .on(({ command, args }) => (command === 'docker' && args[0] === 'volume' ? ok() : undefined))
      .on(({ command }) => (command === 'ss' ? ok('') : undefined))
    const plan = await planInfra(context(host, config()), new Map())
    expect(plan.findings).toEqual([])
  })

  it('the .env\'s credentials are kept when no container says otherwise', async () => {
    const values = new Map([['S3_ACCESS_KEY', 'acme'], ['S3_SECRET_KEY', 'from-env'], ['S3_ENDPOINT', 'http://127.0.0.1:8340']])
    const plan = await planInfra(context(clean(), config()), values)
    expect(plan.services[0]).toMatchObject({ port: 8340, source: 'env' })
    expect(plan.secrets['BASALT_S3_SECRET_KEY']).toBe('from-env')
    expect(plan.env).toEqual([])
  })
})

describe('MinIO is gone (archived upstream)', () => {
  it('dockerInfra({ minio }) and external({ minio }) are refused with the way out', () => {
    expect(() => dockerInfra('acme', { minio: {} } as never)).toThrow(DeployConfigError)
    expect(() => dockerInfra('acme', { minio: {} } as never)).toThrow(/use seaweedfs/i)
    expect(() => validateConfig(acmeConfig({ infra: external({ minio: { container: 'minio' } } as never) }))).toThrow(MINIO_REMOVED.slice(0, 40))
  })
})

describe('an external S3 store', () => {
  const config = () => acmeConfig({ infra: external({ s3: { buckets: ['acme-documents'] } }) })

  it('missing keys in the .env are found before anything is built', async () => {
    const plan = await planInfra(context(new FakeHost(), config()), new Map([['S3_ENDPOINT', 'http://127.0.0.1:8333']]))
    expect(plan.findings).toEqual([expect.objectContaining({ level: 'error', message: 's3: S3_ACCESS_KEY, S3_SECRET_KEY missing in .env' })])
  })

  it('credentials the store refuses are found before anything is built', async () => {
    const host = new FakeHost()
    host.respond = () => ({ status: 403, body: '<Error><Code>InvalidAccessKeyId</Code></Error>' })
    const values = new Map([['S3_ENDPOINT', 'http://127.0.0.1:8333'], ['S3_ACCESS_KEY', 'acme'], ['S3_SECRET_KEY', 'wrong']])
    const plan = await planInfra(context(host, config()), values)
    expect(plan.findings).toEqual([expect.objectContaining({ level: 'error', message: expect.stringContaining('the credentials were refused by http://127.0.0.1:8333 (InvalidAccessKeyId)') })])
  })
})
