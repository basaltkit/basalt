import { describe, expect, it } from 'vitest'
import {
  driveBase,
  itemInDrive,
  itemResource,
  microsoftRoot,
  parseMicrosoftRoot,
  sanitizeName,
  toChecksum,
  toDriveChange,
  toDriveItem,
  toPath,
} from '../src/index.js'

describe('mapping a driveItem', () => {
  it('prefers cTag over eTag as the content version', () => {
    // Graph bumps `eTag` on a rename or a permission edit; `cTag` moves only
    // when the content does. The ledger prefers `version`, so `eTag` would
    // re-download every file somebody renamed.
    expect(toDriveItem({ id: '1', name: 'a', cTag: 'c1', eTag: 'e1' }).version).toBe('c1')
    expect(toDriveItem({ id: '1', name: 'a', eTag: 'e1' }).version).toBe('e1')
  })

  it('builds a human path out of Graph’s addressing path', () => {
    expect(toPath({ id: '1', name: 'invoice.pdf', parentReference: { path: '/drive/root:/Finance/2026' } })).toBe(
      '/Finance/2026/invoice.pdf',
    )
    expect(toPath({ id: '1', name: 'invoice.pdf', parentReference: { path: '/drive/root:' } })).toBe('/invoice.pdf')
    // Graph percent-encodes segments; a malformed escape must not throw.
    expect(toPath({ id: '1', name: 'a', parentReference: { path: '/drive/root:/Relat%C3%B3rios' } })).toBe(
      '/Relatórios/a',
    )
    expect(toPath({ id: '1', name: 'a', parentReference: { path: '/drive/root:/100%' } })).toBe('/100%/a')
  })

  it('labels a checksum by what Graph published, and prefers the one a Business drive has', () => {
    expect(toChecksum({ quickXorHash: 'QUICKxor==', sha1Hash: 'AABB' })).toEqual({
      algorithm: 'quickXorHash',
      value: 'QUICKxor==',
    })
    expect(toChecksum({ sha256Hash: 'AABBCC' })).toEqual({ algorithm: 'sha256', value: 'aabbcc' })
    expect(toChecksum({ sha1Hash: 'AABBCC' })).toEqual({ algorithm: 'sha1', value: 'aabbcc' })
    expect(toChecksum({})).toBeUndefined()
    expect(toChecksum(undefined)).toBeUndefined()
  })

  it('never copies the pre-signed download URL into `raw`', () => {
    const item = toDriveItem({
      id: '1',
      name: 'a',
      parentReference: { driveId: 'b!d' },
      '@microsoft.graph.downloadUrl': 'https://cdn.test/x?tempauth=SECRET',
    })
    // `raw` is handed to sinks, persisted beside the imported file and
    // serialised into logs. A bearer credential in any of those is a leak.
    expect(JSON.stringify(item)).not.toContain('tempauth')
    expect(item.raw).toEqual({ driveId: 'b!d' })
  })

  it('reports a deletion by id, with no path fallback needed', () => {
    expect(toDriveChange({ id: '01AAA', name: 'gone.pdf', deleted: { state: 'deleted' } })).toEqual({
      type: 'removed',
      externalId: '01AAA',
    })
  })

  it('marks a package facet as export-only', () => {
    expect(toDriveItem({ id: '1', name: 'book.one', package: { type: 'oneNote' } }).exportOnly).toBe(true)
    expect(toDriveItem({ id: '1', name: 'a.txt', file: {} }).exportOnly).toBeUndefined()
  })
})

describe('filenames', () => {
  it('removes separators rather than escaping them', () => {
    expect(sanitizeName('a/b\\c.txt')).toBe('a_b_c.txt')
    expect(sanitizeName('../secret')).toBe('__secret')
    expect(sanitizeName('bad"name*here?.txt')).toBe('bad_name_here_.txt')
    expect(sanitizeName('   ')).toBe('file')
    expect(sanitizeName('~$owner.docx')).toBe('_owner.docx')
    expect(sanitizeName('a'.repeat(400))).toHaveLength(255)
  })
})

describe('root handles', () => {
  it('round-trips every shape', () => {
    expect(microsoftRoot({})).toBe('me')
    expect(parseMicrosoftRoot('me', 'microsoft')).toEqual({})
    expect(parseMicrosoftRoot(undefined, 'microsoft')).toEqual({})

    const drive = microsoftRoot({ driveId: 'b!abc-_123', itemId: '01XYZ' })
    expect(drive).toBe('drive:b!abc-_123/item:01XYZ')
    expect(parseMicrosoftRoot(drive, 'microsoft')).toEqual({ driveId: 'b!abc-_123', itemId: '01XYZ' })

    const site = microsoftRoot({ siteId: 'contoso.sharepoint.com,1111,2222' })
    expect(parseMicrosoftRoot(site, 'microsoft')).toEqual({ siteId: 'contoso.sharepoint.com,1111,2222' })

    // A bare id is an item in the connection's own drive — the common case, and
    // the one an app writes without reading the grammar.
    expect(parseMicrosoftRoot('01XYZ', 'microsoft')).toEqual({ itemId: '01XYZ' })
  })

  it('builds the resource a call addresses', () => {
    expect(driveBase({})).toBe('/me/drive')
    expect(driveBase({ driveId: 'b!d' })).toBe('/drives/b!d')
    expect(driveBase({ siteId: 's1' })).toBe('/sites/s1/drive')
    expect(itemResource({})).toBe('/me/drive/root')
    expect(itemResource({ siteId: 's1', itemId: '01X' })).toBe('/sites/s1/drive/items/01X')
    expect(itemInDrive({ driveId: 'b!d' }, '01X', 'microsoft')).toBe('/drives/b!d/items/01X')
  })

  it('refuses every handle that could reshape a request path', () => {
    // `rootId` is caller-controlled: `driveRoutes()` takes it from `?rootId=`.
    // It then becomes part of a Graph URL, so anything that is not one path
    // segment is an attempt to address something else.
    for (const handle of [
      '..',
      'item:..',
      'item:.',
      'drive:b!d/item:../../me/drive',
      'item:01X?$select=*',
      'item:01X#frag',
      'item:01X%2F..',
      'drive:a/drive:b',
      'item:a/item:b',
      'nonsense:x',
      'item:01X/../..',
    ]) {
      expect(() => parseMicrosoftRoot(handle, 'microsoft'), handle).toThrow(/DRIVE_ACCESS_DENIED|refused/)
    }
    // …and the refusal never echoes the handle, which is attacker-chosen text.
    const error = (() => {
      try {
        parseMicrosoftRoot('item:01X?$select=*', 'microsoft')
      } catch (caught) {
        return caught as Error & { details?: unknown }
      }
      return undefined
    })()!
    expect(JSON.stringify({ m: error.message, d: error.details })).not.toContain('$select')
  })

  it('refuses to build a handle from an unusable id', () => {
    expect(() => microsoftRoot({ itemId: '../x' })).toThrow(TypeError)
    expect(() => microsoftRoot({ itemId: '..' })).toThrow(TypeError)
    expect(() => microsoftRoot({ driveId: 'a', siteId: 'b' })).toThrow(TypeError)
  })
})
