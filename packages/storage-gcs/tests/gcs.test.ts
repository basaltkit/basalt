import { describe, expect, it } from 'vitest'
import { Disk, StorageFileNotFoundError } from '@machize/storage'
import { GcsStorageDriver, type GcsBucketLike, type GcsFileLike } from '../src/index.js'

class FakeGcsBucket implements GcsBucketLike {
  readonly files = new Map<string, Buffer>()
  file(path: string): GcsFileLike {
    const store = this.files
    return {
      async save(data: Buffer) {
        store.set(path, data)
      },
      async download(): Promise<[Buffer]> {
        const buffer = store.get(path)
        if (!buffer) {
          const error = new Error('not found') as Error & { code: number }
          error.code = 404
          throw error
        }
        return [buffer]
      },
      async exists(): Promise<[boolean]> {
        return [store.has(path)]
      },
      async delete() {
        store.delete(path)
      },
      async getSignedUrl(config): Promise<[string]> {
        return [`https://gcs.test/${path}?expires=${config.expires}`]
      },
    }
  }
  async getFiles(options?: { prefix?: string }): Promise<[{ name: string }[]]> {
    const prefix = options?.prefix ?? ''
    return [[...this.files.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }))]
  }
}

const make = () => {
  const client = new FakeGcsBucket()
  return { client, driver: new GcsStorageDriver({ bucket: 'b', client }) }
}

describe('GcsStorageDriver', () => {
  it('puts and gets content, with content type', async () => {
    const { client, driver } = make()
    await driver.put('a/b.txt', 'hello', { contentType: 'text/plain' })
    expect((await driver.get('a/b.txt')).toString()).toBe('hello')
    expect(client.files.has('a/b.txt')).toBe(true)
  })

  it('throws StorageFileNotFoundError for a missing object', async () => {
    const { driver } = make()
    await expect(driver.get('missing')).rejects.toBeInstanceOf(StorageFileNotFoundError)
  })

  it('exists, delete and list by prefix', async () => {
    const { driver } = make()
    await driver.put('docs/1.txt', 'x')
    await driver.put('docs/2.txt', 'y')
    await driver.put('img/a.png', 'z')
    expect(await driver.exists('docs/1.txt')).toBe(true)
    expect(await driver.delete('docs/1.txt')).toBe(true)
    expect(await driver.delete('docs/1.txt')).toBe(false) // already gone
    expect((await driver.list('docs/')).sort()).toEqual(['docs/2.txt'])
  })

  it('signs a temporary URL and works through a Disk', async () => {
    const { driver } = make()
    await driver.put('r.pdf', 'data')
    expect(await driver.temporaryUrl('r.pdf', 60_000)).toContain('gcs.test/r.pdf')

    const disk = new Disk('gcs', driver, { scope: null })
    await disk.put('x.txt', 'via disk')
    expect((await disk.get('x.txt')).toString()).toBe('via disk')
  })
})
