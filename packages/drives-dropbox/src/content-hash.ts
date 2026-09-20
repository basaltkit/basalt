import { createHash } from 'node:crypto'

/**
 * Dropbox's `content_hash`.
 *
 * Not SHA-256 of the file, and not a plain digest of anything: the file is cut
 * into 4 MiB blocks, each block is SHA-256'd, the 32-byte digests are
 * concatenated **in order**, and that concatenation is SHA-256'd. The block
 * size is part of the definition — a different one produces a different hash
 * for the same bytes.
 *
 * It exists here so an app can verify what it stored against what Dropbox said
 * it stored, and so the adapter's own tests can generate fixtures that are
 * right rather than merely consistent with themselves. The drives contract
 * carries it as `{ algorithm: 'dropboxContentHash', value }` and never assumes
 * a checksum is comparable across providers.
 */
export const DROPBOX_BLOCK_BYTES = 4 * 1024 * 1024

/** Incremental hasher, so a streamed file is never held in memory. */
export class DropboxContentHash {
  private readonly digests: Buffer[] = []
  private block = createHash('sha256')
  private blockBytes = 0

  update(chunk: Uint8Array): this {
    let offset = 0
    while (offset < chunk.length) {
      const room = DROPBOX_BLOCK_BYTES - this.blockBytes
      const take = Math.min(room, chunk.length - offset)
      this.block.update(chunk.subarray(offset, offset + take))
      this.blockBytes += take
      offset += take
      if (this.blockBytes === DROPBOX_BLOCK_BYTES) this.seal()
    }
    return this
  }

  /** Lowercase hex, exactly as Dropbox reports it. */
  digest(): string {
    if (this.blockBytes > 0) this.seal()
    return createHash('sha256').update(Buffer.concat(this.digests)).digest('hex')
  }

  private seal(): void {
    this.digests.push(this.block.digest())
    this.block = createHash('sha256')
    this.blockBytes = 0
  }
}

/** One-shot convenience for bytes already in memory. */
export function dropboxContentHash(content: Uint8Array): string {
  return new DropboxContentHash().update(content).digest()
}
