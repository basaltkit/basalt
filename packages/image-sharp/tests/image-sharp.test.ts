import { describe, expect, it } from 'vitest'
import type { ImageOp } from '@basaltkit/storage'
import { applyOps, SharpImageProcessor, type SharpLike } from '../src/index.js'

/** Chainable fake that records every call. */
function recordingSharp() {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const image: SharpLike = new Proxy({} as SharpLike, {
    get(_t, prop: string) {
      if (prop === 'toBuffer') return async () => Buffer.from(calls.map((c) => c.method).join(','))
      if (prop === 'metadata') return async () => ({ format: 'png', width: 4, height: 2, size: 99 })
      return (...args: unknown[]) => {
        calls.push({ method: prop, args })
        return image
      }
    },
  })
  return { image, calls }
}

describe('applyOps', () => {
  it('translates the op list into ordered sharp calls', () => {
    const { image, calls } = recordingSharp()
    const ops: ImageOp[] = [
      { op: 'resize', width: 256, height: 128, fit: 'contain' },
      { op: 'rotate', degrees: 90 },
      { op: 'blur', sigma: 3 },
      { op: 'grayscale' },
      { op: 'flip' },
      { op: 'format', format: 'webp', quality: 80 },
    ]
    applyOps(image, ops)
    expect(calls.map((c) => c.method)).toEqual(['resize', 'rotate', 'blur', 'grayscale', 'flip', 'webp'])
    expect(calls[0]!.args[0]).toEqual({ width: 256, height: 128, fit: 'contain' })
    expect(calls[1]!.args).toEqual([90])
    expect(calls[5]!.args[0]).toEqual({ quality: 80 })
  })

  it('calls rotate()/blur() with no args when unspecified (sharp auto-orients)', () => {
    const { image, calls } = recordingSharp()
    applyOps(image, [{ op: 'rotate' }, { op: 'blur' }, { op: 'format', format: 'png' }])
    expect(calls[0]!.args).toEqual([])
    expect(calls[1]!.args).toEqual([])
    expect(calls[2]!.args[0]).toEqual({})
  })
})

describe('SharpImageProcessor', () => {
  it('runs ops through an injected factory and returns the encoded buffer', async () => {
    const { image } = recordingSharp()
    const proc = new SharpImageProcessor({ sharp: () => image })
    const out = await proc.run(Buffer.from('src'), [{ op: 'resize', width: 10 }, { op: 'format', format: 'webp' }])
    expect(out.toString()).toBe('resize,webp')
  })

  it('reads metadata through the injected factory', async () => {
    const { image } = recordingSharp()
    const proc = new SharpImageProcessor({ sharp: () => image })
    expect(await proc.metadata(Buffer.from('x'))).toEqual({ format: 'png', width: 4, height: 2, size: 99 })
  })

  it('propagates engine failures instead of swallowing them', async () => {
    const boom: SharpLike = new Proxy({} as SharpLike, {
      get: () => () => {
        throw new Error('libvips exploded')
      },
    })
    const proc = new SharpImageProcessor({ sharp: () => boom })
    await expect(proc.run(Buffer.from('x'), [{ op: 'grayscale' }])).rejects.toThrow('libvips exploded')
  })
})
