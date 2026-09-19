import { createApp, ensureMetadata, runWithContext, type RequestContext } from '@basaltkit/core'
import { describe, expect, it } from 'vitest'
import { AUDIT, Audit, auditPlugin, createPiiMinimizingRedactor, MemoryAuditStore, redactSensitiveAndPii } from '../src/index.js'

type Enricher = (info: { request: { headers: Record<string, string | string[] | undefined>; ip?: string }; context: RequestContext }) => void

/**
 * Runs the plugin's `http:enrichers` the way every adapter (fastify, express,
 * hono) does through @basaltkit/http's neutral pipeline — so the test covers
 * all three without depending on any of them.
 */
async function viaRequest<T>(
  app: { container: Parameters<typeof ensureMetadata>[0] },
  request: { headers: Record<string, string | string[] | undefined>; ip?: string },
  fn: () => Promise<T>,
): Promise<T> {
  const context: RequestContext = { requestId: 'req-1' }
  return runWithContext(context, async () => {
    for (const enrich of ensureMetadata(app.container).get<Enricher>('http:enrichers')) await enrich({ request, context })
    return fn()
  })
}

describe('request context — ip / userAgent', () => {
  it('is not captured by default (IP is PII: opt-in)', async () => {
    const app = await createApp({ plugins: [auditPlugin({ events: [] })] }).boot()
    const entry = await viaRequest(app, { headers: { 'user-agent': 'curl/8' }, ip: '203.0.113.9' }, () => app.container.get(AUDIT).record('x'))
    expect(entry.ip).toBeUndefined()
    expect(entry.userAgent).toBeUndefined()
  })

  it('captures ip and user-agent from the HTTP request when requestContext: true', async () => {
    const app = await createApp({ plugins: [auditPlugin({ events: [], requestContext: true })] }).boot()
    const audit = app.container.get(AUDIT)
    const entry = await viaRequest(app, { headers: { 'user-agent': 'curl/8' }, ip: '203.0.113.9' }, () => audit.record('x'))
    expect(entry).toMatchObject({ ip: '203.0.113.9', userAgent: 'curl/8', requestId: 'req-1' })
    expect((await audit.systemTrail())[0]).toMatchObject({ ip: '203.0.113.9', userAgent: 'curl/8' })
  })

  it('captures from hook-driven entries too, and truncates an oversized user-agent', async () => {
    const app = await createApp({ plugins: [auditPlugin({ events: [], requestContext: true })] }).boot()
    const huge = 'A'.repeat(5000)
    await viaRequest(app, { headers: { 'user-agent': [huge, 'second'] }, ip: '::1' }, () => app.hooks.emit('auth:login', { user: { id: 'u1' } }))
    const [entry] = await app.container.get(AUDIT).systemTrail()
    expect(entry!.ip).toBe('::1')
    expect(entry!.userAgent!.length).toBe(512)
  })

  it('outside a request (job, CLI) no request fields are set', async () => {
    const app = await createApp({ plugins: [auditPlugin({ events: [], requestContext: true })] }).boot()
    const entry = await app.container.get(AUDIT).record('job.ran')
    expect(entry.ip).toBeUndefined()
  })

  it('accepts a custom resolver', async () => {
    const audit = new Audit(new MemoryAuditStore(), undefined, undefined, {
      requestContext: (context) => ({ ip: context?.['forwardedIp'] as string, userAgent: 'svc' }),
    })
    const entry = await runWithContext({ forwardedIp: '198.51.100.1' }, () => audit.record('x'))
    expect(entry).toMatchObject({ ip: '198.51.100.1', userAgent: 'svc' })
  })

  it('the PII-minimizing redactor pseudonymizes the IP (user-agent kept)', async () => {
    const key = 'k'.repeat(32)
    const app = await createApp({
      plugins: [auditPlugin({ events: [], requestContext: true, redact: createPiiMinimizingRedactor({ key }) })],
    }).boot()
    const entry = await viaRequest(app, { headers: { 'user-agent': 'curl/8' }, ip: '203.0.113.9' }, () => app.container.get(AUDIT).record('x'))
    expect(entry.ip).toMatch(/^pii_[0-9a-f]{32}$/)
    expect(entry.userAgent).toBe('curl/8')
  })

  it('treats ip-address keys in payloads as PII without matching unrelated keys', () => {
    const out = redactSensitiveAndPii({ ip: '1.2.3.4', ipAddress: '1.2.3.4', clientIp: '1.2.3.4', zip: '1000', recipient: 'r' }, 0, {
      key: 'k'.repeat(32),
    }) as Record<string, string>
    expect(out['ip']).toMatch(/^pii_/)
    expect(out['ipAddress']).toMatch(/^pii_/)
    expect(out['clientIp']).toMatch(/^pii_/)
    expect(out['zip']).toBe('1000')
    expect(out['recipient']).toBe('r')
  })

  it('ip and userAgent are covered by the hash chain', async () => {
    const audit = new Audit(new MemoryAuditStore(), undefined, undefined, {
      integrity: 'hash-chain',
      requestContext: () => ({ ip: '203.0.113.9', userAgent: 'curl/8' }),
    })
    const entry = await audit.record('x')
    const store = (audit as unknown as { store: MemoryAuditStore }).store
    const rows = (store as unknown as { entries: typeof entry[] }).entries
    rows[0] = { ...rows[0]!, ip: '10.0.0.1' }
    expect(await audit.verify()).toMatchObject({ ok: false, reason: 'hash-mismatch' })
  })
})
