import { describe, expect, it } from 'vitest'
import { toDriveChange, toDriveItem } from '../src/metadata.js'

describe('toDriveItem', () => {
  it('maps a full file entry', () => {
    expect(
      toDriveItem({
        '.tag': 'file',
        id: 'id:a',
        name: 'invoice.pdf',
        path_lower: '/finance/invoice.pdf',
        path_display: '/Finance/invoice.pdf',
        rev: '015abc',
        size: 12,
        content_hash: 'deadbeef',
        client_modified: '2026-06-01T10:00:00Z',
        server_modified: '2026-06-02T11:00:00Z',
      }),
    ).toEqual({
      externalId: 'id:a',
      name: 'invoice.pdf',
      kind: 'file',
      size: 12,
      path: '/Finance/invoice.pdf',
      version: '015abc',
      checksum: { algorithm: 'dropboxContentHash', value: 'deadbeef' },
      createdAt: Date.parse('2026-06-01T10:00:00Z'),
      updatedAt: Date.parse('2026-06-02T11:00:00Z'),
    })
  })

  it('omits everything Dropbox did not report rather than inventing it', () => {
    // A folder entry carries no rev, size or hash — and the contract prefers an
    // absent field to a zero, because dedup reads `version` first.
    expect(toDriveItem({ '.tag': 'folder', id: 'id:f', name: 'Finance', path_lower: '/finance', path_display: '/Finance' })).toEqual({
      externalId: 'id:f',
      name: 'Finance',
      kind: 'folder',
      path: '/Finance',
    })
  })

  it('ignores an unparseable timestamp instead of producing NaN', () => {
    const item = toDriveItem({ id: 'id:a', name: 'a', path_lower: '/a', path_display: '/a', server_modified: 'whenever' })
    expect(item.updatedAt).toBeUndefined()
  })

  it('falls back to the path when an entry has no id', () => {
    expect(toDriveItem({ name: 'a', path_lower: '/a', path_display: '/a' }).externalId).toBe('/a')
  })

  it('marks an export-only item, and only then', () => {
    expect(toDriveItem({ id: 'id:p', name: 'p', path_lower: '/p', path_display: '/p', is_downloadable: false }).exportOnly).toBe(true)
    expect(toDriveItem({ id: 'id:p', name: 'p', path_lower: '/p', path_display: '/p', is_downloadable: true }).exportOnly).toBeUndefined()
  })
})

describe('toDriveChange', () => {
  it('turns a deleted entry into a path-only removal', () => {
    expect(toDriveChange({ '.tag': 'deleted', name: 'a', path_lower: '/finance/a', path_display: '/Finance/a' })).toEqual({
      type: 'removed',
      path: '/Finance/a',
    })
  })

  it('falls back to path_lower when there is no display path', () => {
    expect(toDriveChange({ '.tag': 'deleted', name: 'a', path_lower: '/finance/a', path_display: undefined as unknown as string })).toEqual({
      type: 'removed',
      path: '/finance/a',
    })
  })

  it('turns anything else into an upsert', () => {
    const change = toDriveChange({ '.tag': 'file', id: 'id:a', name: 'a', path_lower: '/a', path_display: '/a' })
    expect(change.type).toBe('upserted')
  })
})
