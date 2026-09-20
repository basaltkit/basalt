import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DROPBOX_BLOCK_BYTES, DropboxContentHash, dropboxContentHash } from '../src/content-hash.js'

/**
 * These assert the *definition* of Dropbox's `content_hash`, from its published
 * algorithm, not a captured value from live traffic: no official test vector is
 * published and this work uses no real credentials. What they do prove is that
 * the implementation is the block-tree construction rather than a plain digest,
 * that the block boundary is where Dropbox says it is, and that the streaming
 * and one-shot paths agree — which is what the adapter relies on.
 */
describe('dropboxContentHash', () => {
  it('is sha256(sha256(block)) for a file smaller than one block', () => {
    const content = Buffer.from('invoice bytes')
    const expected = createHash('sha256').update(createHash('sha256').update(content).digest()).digest('hex')
    expect(dropboxContentHash(content)).toBe(expected)
  })

  it('is NOT the sha256 of the file', () => {
    const content = Buffer.from('invoice bytes')
    // The distinction the contract's `algorithm` label exists for: comparing
    // this with another provider's SHA-256 of the same bytes would say two
    // identical files differ.
    expect(dropboxContentHash(content)).not.toBe(createHash('sha256').update(content).digest('hex'))
  })

  it('concatenates block digests in order across the 4 MiB boundary', () => {
    const first = Buffer.alloc(DROPBOX_BLOCK_BYTES, 0x61)
    const second = Buffer.alloc(16, 0x62)
    const expected = createHash('sha256')
      .update(
        Buffer.concat([
          createHash('sha256').update(first).digest(),
          createHash('sha256').update(second).digest(),
        ]),
      )
      .digest('hex')
    expect(dropboxContentHash(Buffer.concat([first, second]))).toBe(expected)
  })

  it('gives the same answer however the bytes are chunked', () => {
    const content = Buffer.alloc(DROPBOX_BLOCK_BYTES + 1234, 0x7a)
    const streamed = new DropboxContentHash()
    for (let offset = 0; offset < content.length; offset += 7919) {
      streamed.update(content.subarray(offset, offset + 7919))
    }
    // The adapter hashes a file as it streams; a chunk-dependent answer would
    // make every verification a coin flip.
    expect(streamed.digest()).toBe(dropboxContentHash(content))
  })

  it('handles an empty file', () => {
    expect(dropboxContentHash(Buffer.alloc(0))).toBe(
      createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
    )
  })
})
