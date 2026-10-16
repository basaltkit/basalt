import { createHash, createHmac } from 'node:crypto'
import { bucketName, type Bucket } from './config.js'
import { DeployError, type DeployContext, type Finding } from './context.js'

/**
 * The buckets, over the S3 API itself (RFC 0010 §3). No vendor CLI inside a
 * container (MinIO's `mc` was the only way before): the same requests work on
 * SeaweedFS, Garage, R2 or AWS — whatever the `.env` points at.
 *
 * Requests are signed (SigV4, path style) in this process; the secret never
 * reaches a command line, a file or the screen.
 */

export interface S3Target {
  /** What the messages call it: `seaweedfs`, `s3`. */
  label: string
  /** Reachable from the host running the deploy, e.g. `http://127.0.0.1:8333`. */
  endpoint: string
  accessKey: string
  secretKey: string
  /** @default 'us-east-1' — what SeaweedFS answers to, and AWS's default. */
  region?: string
}

interface S3Response {
  status: number
  body: string
}

const hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest()

/** `20261016T113642Z` and `20261016`. */
function stamps(now: Date): { amz: string; day: string } {
  const amz = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  return { amz, day: amz.slice(0, 8) }
}

/** The SigV4 `Authorization` header and the headers it signs. Exported for the tests. */
export function signedHeaders(target: S3Target, request: { method: string; url: URL; body: string; headers?: Record<string, string> }, now: Date): Record<string, string> {
  const region = target.region ?? 'us-east-1'
  const { amz, day } = stamps(now)
  const payload = hex(request.body)
  const headers: Record<string, string> = {
    host: request.url.host,
    'x-amz-content-sha256': payload,
    'x-amz-date': amz,
    ...Object.fromEntries(Object.entries(request.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
  }
  const names = Object.keys(headers).sort()
  // A subresource (`?versioning`) is `versioning=` in the canonical query.
  const query = [...request.url.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  const canonical = [request.method, request.url.pathname || '/', query, ...names.map((n) => `${n}:${headers[n]?.trim()}`), '', names.join(';'), payload].join('\n')
  const scope = `${day}/${region}/s3/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, hex(canonical)].join('\n')
  const key = hmac(hmac(hmac(hmac(`AWS4${target.secretKey}`, day), region), 's3'), 'aws4_request')
  const signature = createHmac('sha256', key).update(toSign).digest('hex')
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${target.accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` }
}

async function send(ctx: DeployContext, target: S3Target, method: string, bucket: string, subresource = '', body = '', headers: Record<string, string> = {}): Promise<S3Response> {
  let base = target.endpoint
  while (base.endsWith('/')) base = base.slice(0, -1)
  const url = new URL(`${base}/${bucket}`)
  if (subresource) url.search = `?${subresource}=`
  const result = await ctx.host.httpRequest(url.toString(), { method, headers: signedHeaders(target, { method, url, body, headers }, ctx.host.now()), body })
  if ('error' in result) throw new DeployError(`${target.label}: cannot reach ${url.origin} (${result.error})`)
  return result
}

/** The `<Code>` of an S3 error body, for the message. */
const code = (body: string) => body.split('<Code>')[1]?.split('</Code>')[0] ?? ''

function refused(target: S3Target, what: string, response: S3Response): DeployError {
  if (response.status === 403) return new DeployError(`${target.label}: the credentials were refused ${what} (${code(response.body) || 'HTTP 403'})`)
  return new DeployError(`${target.label}: ${what}: HTTP ${response.status}${code(response.body) ? ` ${code(response.body)}` : ''}`)
}

/** Reachable, and the credentials accepted — before anything is built. */
export async function s3Findings(ctx: DeployContext, target: S3Target): Promise<Finding[]> {
  try {
    const listed = await send(ctx, target, 'GET', '')
    if (listed.status === 200) return []
    return [{ id: 'infra', level: 'error', message: refused(target, `by ${target.endpoint}`, listed).message, fix: 'the access and secret keys in the .env must be the store\'s' }]
  } catch (error) {
    return [{ id: 'infra', level: 'error', message: (error as Error).message, fix: 'is the store running, and is the endpoint reachable from this host? (hostEndpoint, when the .env names a container)' }]
  }
}

const XMLNS = 'xmlns="http://s3.amazonaws.com/doc/2006-03-01/"'

/**
 * Whether a lifecycle document already expires EVERYTHING after `days`: an
 * enabled rule with that expiry and no prefix or tag narrowing it. A 1-day
 * rule on `tmp/` does not count.
 */
export function hasExpiry(xml: string, days: number): boolean {
  const compact = xml.replace(/\s+/g, '')
  return compact.split('<Rule>').slice(1).some((after) => {
    const rule = after.split('</Rule>')[0] ?? ''
    if (!rule.includes('<Status>Enabled</Status>') || !rule.includes(`<Expiration><Days>${days}</Days>`)) return false
    if (rule.includes('<Tag>') || rule.includes('<And>')) return false
    return rule.split('<Prefix>').slice(1).every((p) => p.startsWith('</Prefix>'))
  })
}

/** The document with one more rule — the ones already there kept (a PUT replaces them all). */
export function withExpiryRule(existing: string, days: number): string {
  const rule = `<Rule><ID>basalt-expire-${days}d</ID><Status>Enabled</Status><Filter><Prefix></Prefix></Filter><Expiration><Days>${days}</Days></Expiration></Rule>`
  const end = existing.lastIndexOf('</LifecycleConfiguration>')
  if (end === -1) return `<?xml version="1.0" encoding="UTF-8"?><LifecycleConfiguration ${XMLNS}>${rule}</LifecycleConfiguration>`
  return `${existing.slice(0, end)}${rule}${existing.slice(end)}`
}

/** Each bucket exists; versioning on where asked; the expiry rule added once. Says what it did. */
export async function ensureBuckets(ctx: DeployContext, target: S3Target, buckets: Bucket[]): Promise<string> {
  if (buckets.length === 0) return ''
  const said: string[] = []
  for (const bucket of buckets) {
    const name = bucketName(bucket)
    const head = await send(ctx, target, 'HEAD', name)
    if (head.status === 404) {
      const made = await send(ctx, target, 'PUT', name)
      // Owned by these credentials already: a race with another deploy, not an error.
      if (made.status !== 200 && code(made.body) !== 'BucketAlreadyOwnedByYou') throw refused(target, `creating ${name}`, made)
    } else if (head.status !== 200) {
      throw refused(target, `checking ${name}`, head)
    }
    if (typeof bucket === 'string') { said.push(name); continue }

    const notes: string[] = []
    if (bucket.versioned) {
      const state = await send(ctx, target, 'GET', name, 'versioning')
      if (state.status !== 200) throw refused(target, `reading the versioning of ${name}`, state)
      if (!state.body.replace(/\s+/g, '').includes('<Status>Enabled</Status>')) {
        const body = `<VersioningConfiguration ${XMLNS}><Status>Enabled</Status></VersioningConfiguration>`
        const set = await send(ctx, target, 'PUT', name, 'versioning', body, { 'content-type': 'application/xml' })
        if (set.status !== 200) throw refused(target, `turning versioning on for ${name}`, set)
      }
      notes.push('versioned')
    }
    if (bucket.expireDays !== undefined) {
      const current = await send(ctx, target, 'GET', name, 'lifecycle')
      // 404 NoSuchLifecycleConfiguration: no rule yet.
      if (current.status !== 200 && current.status !== 404) throw refused(target, `reading the lifecycle of ${name}`, current)
      const present = current.status === 200 && hasExpiry(current.body, bucket.expireDays)
      if (!present) {
        const body = withExpiryRule(current.status === 200 ? current.body : '', bucket.expireDays)
        // S3 requires the body's MD5 on a lifecycle PUT.
        const md5 = createHash('md5').update(body).digest('base64')
        const set = await send(ctx, target, 'PUT', name, 'lifecycle', body, { 'content-type': 'application/xml', 'content-md5': md5 })
        if (set.status !== 200) throw refused(target, `adding the expiry rule to ${name}`, set)
        const check = await send(ctx, target, 'GET', name, 'lifecycle')
        if (check.status !== 200 || !hasExpiry(check.body, bucket.expireDays)) throw new DeployError(`${target.label}: ${name} accepted the expiry rule but does not report it — the store may not support lifecycle rules`)
      }
      notes.push(`${bucket.expireDays}-day expiry${present ? '' : ' (added)'}`)
    }
    said.push(notes.length ? `${name} (${notes.join(', ')})` : name)
  }
  return `buckets: ${said.join(', ')}`
}
