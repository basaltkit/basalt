/**
 * `fileRoutes()` end to end on every adapter: the streamed download with its
 * quarantine and tenant gates, and the opt-in streamed upload that goes
 * straight into storage. Not a test file on its own — each adapter package
 * runs it against its own driver, the same way it runs the HTTP parity matrix.
 */
import { definePlugin, ensureMetadata, runWithContext } from '@basaltkit/core'
import { GUARDED_META_BUCKET, HttpError, type RequestEnricher, type RouteGuard } from '@basaltkit/http'
import { afterEach, describe, expect, it } from 'vitest'
import { chunked, contentType, multipart } from '../../http/tests/multipart-fixtures.js'
import type { ParityDriver, Send } from '../../http/tests/adapter-parity.js'
import { DEFAULT_MAX_FILE_SIZE, Files, MemoryFileStore, fileRoutes, filesPlugin, type FileRecord } from '../src/index.js'
import { fakeDisk } from './fixtures.js'

/** A 300 KiB PDF: past any single socket read, so a buffered path would show. */
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(300 * 1024 - 9, 0x41)])

/** Stands in for @basaltkit/auth + @basaltkit/tenancy: identity from headers. */
const identity = () =>
  definePlugin({
    name: 'test:identity',
    register({ container }) {
      const metadata = ensureMetadata(container)
      const enricher: RequestEnricher = ({ request, context }) => {
        const user = request.headers['x-user']
        const tenant = request.headers['x-tenant']
        const scope = context as unknown as Record<string, unknown>
        if (typeof user === 'string' && user) scope['user'] = { id: user }
        if (typeof tenant === 'string' && tenant) scope['tenant'] = { id: tenant }
      }
      const guard: RouteGuard = ({ route, context }) => {
        const scope = context as unknown as Record<string, unknown>
        if (route.meta?.['auth'] === true && !scope['user']) throw new HttpError(401, 'AUTH_REQUIRED', 'Sign in.')
      }
      metadata.add('http:enrichers', enricher)
      metadata.add('http:guards', guard)
      metadata.add(GUARDED_META_BUCKET, 'auth')
      // The marker `tenancyPlugin` sets: it is how @basaltkit/files learns the
      // app is multi-tenant without importing the tenancy package.
      metadata.add('tenancy:active', true)
    },
  })

export function fileRoutesParitySuite(adapter: string, driver: ParityDriver): void {
  describe(`${adapter}: fileRoutes() streaming parity (BK-019)`, () => {
    let disk = fakeDisk()
    let store = new MemoryFileStore()
    let send: Send

    const boot = async (
      plugin: { requireScan?: boolean } = {},
      routes: Parameters<typeof fileRoutes>[0] = { upload: { maxBytes: 2 * 1024 * 1024, maxFiles: 2 } },
      options: { streaming?: boolean } = {},
    ) => {
      disk = fakeDisk()
      // A driver with no `getStream` — shadowing the prototype method is what a
      // driver that never implemented it looks like to `disk.supports()`.
      if (options.streaming === false) (disk.driver as { getStream?: unknown }).getStream = undefined
      store = new MemoryFileStore()
      send = await driver.boot(fileRoutes(routes), [
        identity(),
        filesPlugin({ disk: disk.disk, store, ...plugin }),
      ])
    }
    afterEach(() => driver.close())

    /** Puts a file in storage directly, the way an application's own code would. */
    const seed = async (
      tenantId: string,
      uploadedBy: string,
      options: { requireScan?: boolean; scan?: { clean: boolean } } = {},
    ): Promise<FileRecord> => {
      const service = new Files(
        { disk: disk.disk, store, ...(options.requireScan !== undefined ? { requireScan: options.requireScan } : {}) },
        () => true,
      )
      return runWithContext({ tenant: { id: tenantId } } as never, async () => {
        const record = await service.upload(PDF, { name: 'contrato final.pdf', contentType: 'application/pdf', uploadedBy })
        if (options.scan) await service.markScanned(record.id, options.scan)
        return (await service.get(record.id))!
      })
    }

    const as = (user: string, tenant: string) => ({ 'x-user': user, 'x-tenant': tenant })

    it('uploads straight into storage through POST /files', async () => {
      await boot()
      const body = multipart([
        { name: 'doc', filename: '../../etc/contrato.pdf', type: 'application/pdf', data: PDF, length: PDF.length },
      ])
      const res = await send({
        method: 'POST',
        url: '/files',
        headers: { 'content-type': contentType(), ...as('alice', 'acme') },
        // Sent in pieces, as a real upload arrives, so the streaming path is
        // exercised the same way on an in-process runtime and over a socket.
        body: chunked(body, 64 * 1024),
      })
      expect(res.status).toBe(201)
      const [record] = res.json as FileRecord[]
      expect(record).toMatchObject({
        name: 'contrato.pdf',
        contentType: 'application/pdf',
        size: PDF.length,
        tenantId: 'acme',
        uploadedBy: 'alice',
      })
      // Stored, byte for byte, and written in pieces rather than buffered whole.
      // (The driver key carries the disk's own prefix on top of `record.path`.)
      const key = [...disk.driver.files.keys()].find((name) => name.endsWith(record!.path))!
      expect(disk.driver.files.get(key)!.equals(PDF)).toBe(true)
      expect(disk.driver.streamed.get(key)!.length).toBeGreaterThan(1)
      // The part's own Content-Length reached the backend, so a driver that
      // needs an exact size (S3) can stream instead of buffering.
      expect(disk.driver.streamOptions.get(key)?.contentLength).toBe(PDF.length)
    })

    it('refuses an unauthenticated upload before reading the body', async () => {
      await boot()
      const res = await send({
        method: 'POST',
        url: '/files',
        headers: { 'content-type': contentType(), 'x-tenant': 'acme' },
        body: multipart([{ name: 'doc', filename: 'a.pdf', type: 'application/pdf', data: PDF }]),
      })
      expect(res.status).toBe(401)
      expect(await store.list('acme')).toEqual([])
    })

    it('mounts no upload route unless one is configured', async () => {
      await boot({}, {})
      const res = await send({
        method: 'POST',
        url: '/files',
        headers: { 'content-type': contentType(), ...as('alice', 'acme') },
        body: multipart([{ name: 'doc', filename: 'a.pdf', type: 'application/pdf', data: PDF }]),
      })
      expect(res.status).toBe(404)
    })

    it('streams the bytes back from GET /files/:id/content', async () => {
      await boot()
      const record = await seed('acme', 'alice')
      const res = await send({ method: 'GET', url: `/files/${record.id}/content`, headers: as('alice', 'acme') })
      expect(res.status).toBe(200)
      expect(res.bytes.equals(PDF)).toBe(true)
      expect(res.headers['content-type']).toBe('application/pdf')
      expect(res.headers['content-length']).toBe(String(PDF.length))
      expect(res.headers['content-disposition']).toBe('attachment; filename="contrato final.pdf"')
    })

    it('answers 404 for another tenant’s file, and for another user’s', async () => {
      await boot()
      const record = await seed('acme', 'alice')
      const missing = { error: { code: 'FILE_NOT_FOUND', message: 'File not found.' } }
      const other = await send({ method: 'GET', url: `/files/${record.id}/content`, headers: as('bob', 'globex') })
      expect([other.status, other.json]).toEqual([404, missing])
      // Owner-only is the default policy, even inside the same tenant.
      const colleague = await send({ method: 'GET', url: `/files/${record.id}/content`, headers: as('bob', 'acme') })
      expect([colleague.status, colleague.json]).toEqual([404, missing])
    })

    it('holds a quarantined file back with 423, before a single byte', async () => {
      await boot({ requireScan: true })
      const record = await seed('acme', 'alice', { requireScan: true })
      const res = await send({ method: 'GET', url: `/files/${record.id}/content`, headers: as('alice', 'acme') })
      expect(res.status).toBe(423)
      expect(res.json).toEqual({ error: { code: 'FILE_NOT_SCANNED', message: 'File is quarantined until it has been scanned.' } })
      expect(res.headers['content-type']).toContain('application/json')
      expect(res.headers['content-disposition']).toBeUndefined()
    })

    it('refuses an infected file with 403, and serves one scanned clean', async () => {
      await boot({ requireScan: true })
      const infected = await seed('acme', 'alice', { requireScan: true, scan: { clean: false } })
      const clean = await seed('acme', 'alice', { requireScan: true, scan: { clean: true } })
      const refused = await send({ method: 'GET', url: `/files/${infected.id}/content`, headers: as('alice', 'acme') })
      expect([refused.status, (refused.json as { error: { code: string } }).error.code]).toEqual([403, 'FILE_INFECTED'])
      const served = await send({ method: 'GET', url: `/files/${clean.id}/content`, headers: as('alice', 'acme') })
      expect(served.status).toBe(200)
      expect(served.bytes.equals(PDF)).toBe(true)
    })

    it('still serves a driver that cannot stream, buffered', async () => {
      await boot({}, { upload: { maxBytes: 2 * 1024 * 1024 } }, { streaming: false })
      const record = await seed('acme', 'alice')
      const res = await send({ method: 'GET', url: `/files/${record.id}/content`, headers: as('alice', 'acme') })
      expect(res.status).toBe(200)
      expect(res.bytes.equals(PDF)).toBe(true)
      expect(res.headers['content-length']).toBe(String(PDF.length))
    })

    it('refuses a file type outside allowedTypes, and a second file past the default maxFiles', async () => {
      await boot({}, { upload: { maxBytes: 2 * 1024 * 1024, allowedTypes: ['application/pdf'] } })
      const html = await send({
        method: 'POST',
        url: '/files',
        headers: { 'content-type': contentType(), ...as('alice', 'acme') },
        body: multipart([{ name: 'doc', filename: 'x.html', type: 'text/html', data: '<script>' }]),
      })
      expect(html.status).toBe(415)
      // `maxFiles` defaults to 1 when the route options leave it out.
      const two = await send({
        method: 'POST',
        url: '/files',
        headers: { 'content-type': contentType(), ...as('alice', 'acme') },
        body: multipart([
          { name: 'a', filename: 'a.pdf', type: 'application/pdf', data: '%PDF-1.7\n' },
          { name: 'b', filename: 'b.pdf', type: 'application/pdf', data: '%PDF-1.7\n' },
        ]),
      })
      expect([two.status, (two.json as { error: { code: string } }).error.code]).toEqual([400, 'TOO_MANY_FILES'])
    })

    it('uploads a part that declares no length, bounded by validate.maxSize instead', async () => {
      await boot()
      const res = await send({
        method: 'POST',
        url: '/files',
        headers: { 'content-type': contentType(), ...as('alice', 'acme') },
        body: chunked(multipart([{ name: 'doc', filename: 'a.pdf', type: 'application/pdf', data: PDF }]), 64 * 1024),
      })
      expect(res.status).toBe(201)
      const [record] = res.json as FileRecord[]
      const key = [...disk.driver.files.keys()].find((name) => name.endsWith(record!.path))!
      const streamOptions = disk.driver.streamOptions.get(key)
      expect(streamOptions?.contentLength).toBeUndefined()
      // Nothing is invented: the backend gets the configured cap as its bound.
      expect(streamOptions?.maxBytes).toBe(DEFAULT_MAX_FILE_SIZE)
      expect(disk.driver.files.get(key)!.equals(PDF)).toBe(true)
    })

    it('mounts no download route when download is off', async () => {
      await boot({}, { download: false })
      const record = await seed('acme', 'alice')
      const res = await send({ method: 'GET', url: `/files/${record.id}/content`, headers: as('alice', 'acme') })
      expect(res.status).toBe(404)
      expect(res.json).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found.' } })
    })
  })
}
