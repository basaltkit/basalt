import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runWithContext } from '@basaltkit/core'
import {
  Disk,
  ImageProcessingUnavailableError,
  LocalStorageDriver,
  type ImageOp,
  type ImageProcessor,
} from '../src/index.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'basalt-image-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Records the ops it was asked to run and echoes a marker buffer. */
class FakeImageProcessor implements ImageProcessor {
  readonly name = 'fake'
  lastOps: ImageOp[] = []
  lastInput?: Buffer
  async run(input: Buffer, ops: ImageOp[]): Promise<Buffer> {
    this.lastInput = input
    this.lastOps = ops
    return Buffer.from(`processed:${ops.map((o) => o.op).join(',')}`)
  }
  async metadata(input: Buffer): Promise<{ format: string; width: number; height: number; size: number }> {
    return { format: 'png', width: 10, height: 20, size: input.byteLength }
  }
}

const makeDisk = (processor?: ImageProcessor) =>
  new Disk('uploads', new LocalStorageDriver({ root }), {
    scope: null,
    ...(processor ? { imageProcessor: processor } : {}),
  })

describe('ImagePipeline (via disk.image)', () => {
  it('collects a fluent chain into an ordered op list', () => {
    const p = makeDisk(new FakeImageProcessor())
      .image('a.png')
      .resize(256, 128, { fit: 'contain' })
      .rotate(90)
      .grayscale()
      .webp(80)
    expect(p.pipeline).toEqual([
      { op: 'resize', width: 256, height: 128, fit: 'contain' },
      { op: 'rotate', degrees: 90 },
      { op: 'grayscale' },
      { op: 'format', format: 'webp', quality: 80 },
    ])
  })

  it('toBuffer feeds the source bytes and ops to the engine', async () => {
    const engine = new FakeImageProcessor()
    const disk = makeDisk(engine)
    await disk.put('a.png', Buffer.from('SRC'))
    const out = await disk.image('a.png').resize(64).png().toBuffer()
    expect(engine.lastInput?.toString()).toBe('SRC')
    expect(engine.lastOps.map((o) => o.op)).toEqual(['resize', 'format'])
    expect(out.toString()).toBe('processed:resize,format')
  })

  it('save() writes the result back with the format content type', async () => {
    const disk = makeDisk(new FakeImageProcessor())
    await disk.put('a.png', Buffer.from('SRC'))
    await disk.image('a.png').resize(32, 32).webp().save('a.webp')
    expect((await disk.get('a.webp')).toString()).toBe('processed:resize,format')
  })

  it('metadata delegates to the engine without running ops', async () => {
    const disk = makeDisk(new FakeImageProcessor())
    await disk.put('a.png', Buffer.from('SRCBYTES'))
    expect(await disk.image('a.png').resize(9).metadata()).toEqual({
      format: 'png',
      width: 10,
      height: 20,
      size: 8,
    })
  })

  it('resize omits undefined dimensions', () => {
    expect(makeDisk(new FakeImageProcessor()).image('a.png').resize(undefined, 100).pipeline).toEqual([
      { op: 'resize', height: 100 },
    ])
  })

  it('throws a clear error when no engine is configured', async () => {
    const disk = makeDisk()
    await disk.put('a.png', Buffer.from('SRC'))
    await expect(disk.image('a.png').webp().toBuffer()).rejects.toBeInstanceOf(ImageProcessingUnavailableError)
  })

  it('honors tenant scoping on both read and write', async () => {
    const engine = new FakeImageProcessor()
    const disk = new Disk('uploads', new LocalStorageDriver({ root }), { imageProcessor: engine })
    await runWithContext({ tenant: { id: 't1' } }, async () => {
      await disk.put('a.png', Buffer.from('SRC'))
      await disk.image('a.png').webp().save('a.webp')
    })
    // scoped path written under tenants/t1
    const raw = new Disk('uploads', new LocalStorageDriver({ root }), { scope: null })
    expect(await raw.exists('tenants/t1/a.webp')).toBe(true)
  })
})
