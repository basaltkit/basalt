import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Disk, LocalStorageDriver, StorageInvalidKeyError } from '../src/index.js'

/**
 * Framework audit residual: `a/./b` and `a//b` were accepted. The local driver
 * resolves them to the same file as `a/b`, while S3/GCS/Azure store three
 * different objects — so a key allow-list, a dedupe or a delete written against
 * `a/b` behaved differently per driver. Non-canonical keys are now refused on
 * every driver, at the Disk choke point.
 */
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'basalt-storage-keys-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const central = () => new Disk('local', new LocalStorageDriver({ root }), { scope: null })

describe('Disk · non-canonical keys are refused on every operation', () => {
  it.each(['a/./b.txt', './a.txt', 'a/.', 'a//b.txt', 'a/b/', 'a\\\\b.txt', '.', 'a/b.txt/.', ''])('put(%j) throws', async (key) => {
    await expect(central().put(key, 'x')).rejects.toBeInstanceOf(StorageInvalidKeyError)
  })

  it('the refusal is the same for get/exists/delete/copy/temporaryUrl paths', async () => {
    const disk = central()
    await disk.put('a/b.txt', 'real')
    await expect(disk.get('a/./b.txt')).rejects.toBeInstanceOf(StorageInvalidKeyError)
    await expect(disk.exists('a//b.txt')).rejects.toBeInstanceOf(StorageInvalidKeyError)
    await expect(disk.delete('a/./b.txt')).rejects.toBeInstanceOf(StorageInvalidKeyError)
    await expect(disk.copy('a/b.txt', 'c//d.txt')).rejects.toBeInstanceOf(StorageInvalidKeyError)
    expect(await disk.get('a/b.txt')).toEqual(Buffer.from('real'))
  })

  it('list() accepts "" and a trailing "/" on a prefix, but not inner empty or "." segments', async () => {
    const disk = central()
    await disk.put('a/b.txt', 'x')
    expect(await disk.list('')).toEqual(['a/b.txt'])
    expect(await disk.list('a/')).toEqual(['a/b.txt'])
    await expect(disk.list('a//')).rejects.toBeInstanceOf(StorageInvalidKeyError)
    await expect(disk.list('./a')).rejects.toBeInstanceOf(StorageInvalidKeyError)
  })

  it('canonical keys, including dotfiles and dotted names, still work', async () => {
    const disk = central()
    for (const key of ['.env.example', 'a/.hidden', 'a/b.c.d', 'a/..b', 'a/b..']) {
      await disk.put(key, key)
      expect(await disk.get(key)).toEqual(Buffer.from(key))
    }
  })
})
