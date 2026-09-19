import { describe, expect, it } from 'vitest'
import { Container, HookBus, runWithContext } from '@basaltkit/core'
import { toErrorResponse } from '@basaltkit/http'
import {
  FILES,
  FileInfectedError,
  FileNotScannedError,
  Files,
  MemoryFileStore,
  fileRoutes,
  filesPlugin,
  type FileRecord,
} from '../src/index.js'
import { fakeDisk } from './fixtures.js'

const png = Buffer.from('fake-png-bytes')

function setup(requireScan?: boolean) {
  const { disk } = fakeDisk()
  const store = new MemoryFileStore()
  const files = new Files({ disk, store, ...(requireScan !== undefined ? { requireScan } : {}) })
  return { files, store }
}

const upload = (files: Files) => files.upload(png, { name: 'a.png', contentType: 'image/png', tenantId: 'acme', uploadedBy: 'u1' })

describe('BK-004 · requireScan quarantines files until scanned clean', () => {
  it('an unscanned file is not served: 423 FILE_NOT_SCANNED from download and temporaryUrl', async () => {
    const { files } = setup(true)
    const record = await upload(files)
    const error = await files.download(record.id, 'acme').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FileNotScannedError)
    expect(toErrorResponse(error)).toEqual({
      status: 423,
      body: { error: { code: 'FILE_NOT_SCANNED', message: 'File is quarantined until it has been scanned.' } },
    })
    await expect(files.temporaryUrl(record.id, '5m', 'acme')).rejects.toBeInstanceOf(FileNotScannedError)
  })

  it('the scanner reads a quarantined file with bypassQuarantine (and only it)', async () => {
    const { files } = setup(true)
    const record = await upload(files)
    expect((await files.download(record.id, 'acme', { bypassQuarantine: true })).content).toEqual(png)
    await files.markScanned(record.id, { clean: false }, 'acme')
    expect((await files.download(record.id, 'acme', { bypassQuarantine: true })).content).toEqual(png)
    await expect(files.download(record.id, 'acme')).rejects.toBeInstanceOf(FileInfectedError)
  })

  it('a file scanned clean is served', async () => {
    const { files } = setup(true)
    const record = await upload(files)
    await files.markScanned(record.id, { clean: true }, 'acme')
    expect((await files.download(record.id, 'acme')).content).toEqual(png)
    expect(await files.temporaryUrl(record.id, '5m', 'acme')).toContain('https://fake/')
  })

  it('a file scanned NOT clean is never served: 403 FILE_INFECTED', async () => {
    const { files } = setup(true)
    const record = await upload(files)
    await files.markScanned(record.id, { clean: false, detail: 'EICAR' }, 'acme')
    const error = await files.download(record.id, 'acme').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FileInfectedError)
    expect(toErrorResponse(error).status).toBe(403)
    await expect(files.temporaryUrl(record.id, '5m', 'acme')).rejects.toBeInstanceOf(FileInfectedError)
  })

  it('fails closed on a scan timestamp without a clean verdict', async () => {
    const { files, store } = setup(true)
    const record = await upload(files)
    await store.update('acme', record.id, { scannedAt: 1 })
    await expect(files.download(record.id, 'acme')).rejects.toBeInstanceOf(FileNotScannedError)
  })

  it('listing still shows every file with its scan state', async () => {
    const { files } = setup(true)
    const a = await upload(files)
    const b = await upload(files)
    await files.markScanned(b.id, { clean: false }, 'acme')
    const listed = await files.list('acme')
    expect(listed.map((r) => r.id).sort()).toEqual([a.id, b.id].sort())
    expect(listed.find((r) => r.id === a.id)?.scannedAt).toBeUndefined()
    expect(listed.find((r) => r.id === b.id)?.metadata?.['scan']).toEqual({ clean: false })
  })

  it('off by default: scan results are recorded but do not gate access (unchanged behaviour)', async () => {
    const { files } = setup()
    const record = await upload(files)
    await files.markScanned(record.id, { clean: false }, 'acme')
    expect((await files.download(record.id, 'acme')).content).toEqual(png)
  })

  it('filesPlugin({ requireScan: true }) wires it through', async () => {
    const container = new Container()
    const { disk } = fakeDisk()
    filesPlugin({ disk, requireScan: true }).register?.({ container, hooks: new HookBus(), config: undefined })
    const files = container.get(FILES)
    const record = await upload(files)
    await expect(files.download(record.id, 'acme')).rejects.toBeInstanceOf(FileNotScannedError)
  })

  it('fileRoutes: POST /files/:id/url surfaces 423 while GET /files/:id still answers with the scan state', async () => {
    const { files } = setup(true)
    const record = await upload(files)
    const container = new Container()
    container.singleton(FILES, () => files)
    const routes = fileRoutes()
    const find = (method: string, url: string) => routes.find((r) => r.method === method && r.url === url)!
    const reply = { code: () => reply, send: (p: unknown) => p, header: () => reply }
    const call = (method: string, url: string) =>
      runWithContext({ container, user: { id: 'u1' }, tenant: { id: 'acme' } } as never, () =>
        Promise.resolve(find(method, url).handler({ params: { id: record.id }, reply } as never)),
      )

    const error = await call('POST', '/files/:id/url').catch((e: unknown) => e)
    expect(toErrorResponse(error).status).toBe(423)
    expect(((await call('GET', '/files/:id')) as FileRecord).id).toBe(record.id)
  })
})
