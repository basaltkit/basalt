import { describe, expect, it } from 'vitest'
import { Disk, StorageFileNotFoundError } from '@machize/storage'
import { AzureBlobStorageDriver, type AzureBlobLike, type AzureContainerLike } from '../src/index.js'

class FakeAzureContainer implements AzureContainerLike {
  readonly blobs = new Map<string, Buffer>()
  getBlockBlobClient(path: string): AzureBlobLike {
    const store = this.blobs
    return {
      async uploadData(data: Buffer) {
        store.set(path, data)
      },
      async downloadToBuffer(): Promise<Buffer> {
        const buffer = store.get(path)
        if (!buffer) {
          const error = new Error('not found') as Error & { statusCode: number }
          error.statusCode = 404
          throw error
        }
        return buffer
      },
      async exists(): Promise<boolean> {
        return store.has(path)
      },
      async deleteIfExists(): Promise<{ succeeded: boolean }> {
        return { succeeded: store.delete(path) }
      },
      async generateSasUrl(options): Promise<string> {
        return `https://azure.test/${path}?sas&expires=${options.expiresOn.getTime()}`
      },
    }
  }
  async *listBlobsFlat(options?: { prefix?: string }): AsyncIterable<{ name: string }> {
    const prefix = options?.prefix ?? ''
    for (const name of this.blobs.keys()) if (name.startsWith(prefix)) yield { name }
  }
}

const make = () => {
  const client = new FakeAzureContainer()
  return { client, driver: new AzureBlobStorageDriver({ container: 'c', client }) }
}

describe('AzureBlobStorageDriver', () => {
  it('puts and gets content, with content type', async () => {
    const { client, driver } = make()
    await driver.put('a/b.txt', 'hello', { contentType: 'text/plain' })
    expect((await driver.get('a/b.txt')).toString()).toBe('hello')
    expect(client.blobs.has('a/b.txt')).toBe(true)
  })

  it('throws StorageFileNotFoundError for a missing blob', async () => {
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
    expect(await driver.delete('docs/1.txt')).toBe(false)
    expect((await driver.list('docs/')).sort()).toEqual(['docs/2.txt'])
  })

  it('signs a SAS URL and works through a Disk', async () => {
    const { driver } = make()
    await driver.put('r.pdf', 'data')
    expect(await driver.temporaryUrl('r.pdf', 60_000)).toContain('azure.test/r.pdf')

    const disk = new Disk('azure', driver, { scope: null })
    await disk.put('x.txt', 'via disk')
    expect((await disk.get('x.txt')).toString()).toBe('via disk')
  })
})
