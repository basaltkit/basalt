import { describe, expect, it } from 'vitest'
import { FOLDER_MIME, SHORTCUT_MIME, isNativeDoc, isRemoval, toDriveItem } from '../src/metadata.js'

describe('toDriveItem', () => {
  it('prefers headRevisionId over Drive’s own version counter', () => {
    // Drive's `version` moves on ANY change, a rename included, and
    // `contentVersion()` prefers `version` over the checksum — so using the
    // counter would re-download a file every time someone renamed it.
    const item = toDriveItem({ id: 'f', name: 'a.pdf', headRevisionId: 'head-9', version: '412' })
    expect(item.version).toBe('head-9')
  })

  it('falls back to the checksum when there is no head revision', () => {
    const item = toDriveItem({ id: 'f', name: 'a.pdf', md5Checksum: 'abc' })
    expect(item.version).toBeUndefined()
    // Content-exact, so dedup still works — it just costs a checksum compare.
    expect(item.checksum).toEqual({ algorithm: 'md5', value: 'abc' })
  })

  it('labels the checksum md5, because that is what it is', () => {
    // Comparable with anyone else's MD5 of the same bytes, unlike Dropbox's
    // block-tree `content_hash`. Mislabelling it is how an app concludes two
    // identical files differ.
    expect(toDriveItem({ id: 'f', name: 'a', md5Checksum: 'd41d8' }).checksum?.algorithm).toBe('md5')
  })

  it('parses the string size Drive reports', () => {
    expect(toDriveItem({ id: 'f', name: 'a', size: '1024' }).size).toBe(1024)
    expect(toDriveItem({ id: 'f', name: 'a' }).size).toBeUndefined()
  })

  it('maps a folder', () => {
    expect(toDriveItem({ id: 'f', name: 'Finance', mimeType: FOLDER_MIME }).kind).toBe('folder')
  })

  it('carries only the FIRST parent, because Drive is a graph', () => {
    const item = toDriveItem({ id: 'f', name: 'a', parents: ['p1', 'p2'] })
    expect(item.parentId).toBe('p1')
    // And never a path: a "path" is a display convention Drive does not
    // publish, so inventing one would be a fabrication the ledger might trust.
    expect(item.path).toBeUndefined()
  })

  it('marks a native document export-only and keeps its mime type in raw', () => {
    const item = toDriveItem({ id: 'f', name: 'Contract', mimeType: 'application/vnd.google-apps.spreadsheet' })
    expect(item.exportOnly).toBe(true)
    expect(item.raw?.['mimeType']).toBe('application/vnd.google-apps.spreadsheet')
  })

  it('does not treat a folder or a shortcut as a native document', () => {
    expect(isNativeDoc(FOLDER_MIME)).toBe(false)
    expect(isNativeDoc(SHORTCUT_MIME)).toBe(false)
    expect(isNativeDoc('application/vnd.google-apps.document')).toBe(true)
    expect(isNativeDoc('application/pdf')).toBe(false)
    expect(isNativeDoc(undefined)).toBe(false)
  })

  it('survives a resource with nothing in it', () => {
    // A `fields` mask that drops something, a partial response, a future
    // change: none of them should produce an item that throws downstream.
    const item = toDriveItem({})
    expect(item).toMatchObject({ externalId: '', name: '', kind: 'file' })
  })

  it('keeps the web link as externalUrl — stored and shown, never fetched', () => {
    const item = toDriveItem({ id: 'f', name: 'a', webViewLink: 'https://drive.google.com/file/d/f/view' })
    expect(item.externalUrl).toBe('https://drive.google.com/file/d/f/view')
  })
})

describe('isRemoval', () => {
  it('recognises a hard deletion, which carries no file resource', () => {
    expect(isRemoval({ fileId: 'f', removed: true })).toBe(true)
  })

  it('recognises a trash, which carries a full one', () => {
    expect(isRemoval({ fileId: 'f', file: { id: 'f', name: 'a', trashed: true } })).toBe(true)
  })

  it('leaves an ordinary change alone', () => {
    expect(isRemoval({ fileId: 'f', file: { id: 'f', name: 'a' } })).toBe(false)
  })
})
