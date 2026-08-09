import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openCommentsDatabase, SqliteCommentStore, sqliteCommentsStore } from '../src/index.js'

const base = {
  tenantId: 'acme', resourceType: 'issue', resourceId: '1',
  authorId: 'u1', mentions: ['u2'],
}

describe('SqliteCommentStore', () => {
  it('creates, finds, lists a thread and deletes', async () => {
    const store = new SqliteCommentStore(openCommentsDatabase())
    await store.create({ id: 'c1', body: 'first', createdAt: 1, ...base })
    await store.create({ id: 'c2', body: 'reply', createdAt: 2, parentId: 'c1', ...base })
    await store.create({ id: 'c3', body: 'other', createdAt: 3, ...base, resourceId: '2' })

    const c1 = await store.find('acme', 'c1')
    expect(c1?.body).toBe('first')
    expect(c1?.mentions).toEqual(['u2'])
    expect(c1?.parentId).toBeUndefined()
    expect((await store.find('acme', 'c2'))?.parentId).toBe('c1')
    expect(await store.find('acme', 'missing')).toBeNull()
    expect(await store.find('other', 'c1')).toBeNull() // tenant-scoped

    expect((await store.list('acme', 'issue', '1')).map((c) => c.id)).toEqual(['c1', 'c2'])
    expect((await store.list('acme', 'issue', '2')).map((c) => c.id)).toEqual(['c3'])

    await store.delete('acme', 'c1')
    expect(await store.find('acme', 'c1')).toBeNull()
  })

  it('edits, resolves and reopens', async () => {
    const store = new SqliteCommentStore(openCommentsDatabase())
    await store.create({ id: 'c1', body: 'first', createdAt: 1, ...base })

    const edited = await store.update('acme', 'c1', { body: 'edited', mentions: ['u3'], editedAt: 50 })
    expect(edited?.body).toBe('edited')
    expect(edited?.mentions).toEqual(['u3'])
    expect(edited?.editedAt).toBe(50)

    const resolved = await store.update('acme', 'c1', { resolvedAt: 100, resolvedBy: 'u9' })
    expect(resolved?.resolvedAt).toBe(100)
    expect(resolved?.resolvedBy).toBe('u9')

    // reopen: keys present with undefined clear the columns
    const reopened = await store.update('acme', 'c1', { resolvedAt: undefined, resolvedBy: undefined })
    expect(reopened?.resolvedAt).toBeUndefined()
    expect(reopened?.resolvedBy).toBeUndefined()

    // clearing mentions writes an empty array (the column is NOT NULL)
    const clear = { mentions: undefined } as unknown as Parameters<typeof store.update>[2]
    expect((await store.update('acme', 'c1', clear))?.mentions).toEqual([])

    expect(await store.update('acme', 'ghost', { body: 'x' })).toBeNull() // not found
    expect((await store.update('acme', 'c1', {}))?.id).toBe('c1') // empty patch = read
  })
})

describe('sqliteCommentsStore + durability', () => {
  const dir = mkdtempSync(join(tmpdir(), 'basalt-comments-'))
  const file = join(dir, 'comments.db')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('bundles the store named for commentsPlugin', () => {
    expect(sqliteCommentsStore().store).toBeInstanceOf(SqliteCommentStore)
  })

  it('accepts an existing DatabaseSync and migrates it', async () => {
    const db = openCommentsDatabase()
    const c = sqliteCommentsStore(db)
    expect(c.db).toBe(db)
    await c.store.create({ id: 'c1', body: 'x', createdAt: 1, ...base })
    expect(await new SqliteCommentStore(db).find('acme', 'c1')).not.toBeNull()
  })

  it('survives a process restart', async () => {
    const first = sqliteCommentsStore(file)
    await first.store.create({ id: 'c1', body: 'persist', createdAt: 1, ...base })
    first.db.close()
    const second = sqliteCommentsStore(file)
    expect((await second.store.find('acme', 'c1'))?.body).toBe('persist')
    second.db.close()
  })
})
