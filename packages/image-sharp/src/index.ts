import type { ImageMetadata, ImageOp, ImageProcessor } from '@basaltkit/storage'

/**
 * The slice of sharp's fluent API this driver uses. Declared structurally so the
 * op translator is testable with a fake and the core never imports sharp's types.
 */
export interface SharpLike {
  resize(options: {
    width?: number
    height?: number
    fit?: string
    position?: string
  }): SharpLike
  rotate(degrees?: number): SharpLike
  blur(sigma?: number): SharpLike
  grayscale(): SharpLike
  flip(): SharpLike
  flop(): SharpLike
  jpeg(options?: { quality?: number }): SharpLike
  png(options?: { quality?: number }): SharpLike
  webp(options?: { quality?: number }): SharpLike
  avif(options?: { quality?: number }): SharpLike
  toBuffer(): Promise<Buffer>
  metadata(): Promise<{ format?: string; width?: number; height?: number; size?: number }>
}

/** `sharp(input)` — the module's callable default export. */
export type SharpFactory = (input: Buffer) => SharpLike

/**
 * Applies the engine-neutral op list to a sharp instance, in order. Pure and
 * synchronous over the chainable — unit-tested without the native binary.
 */
export function applyOps(image: SharpLike, ops: readonly ImageOp[]): SharpLike {
  let out = image
  for (const op of ops) {
    switch (op.op) {
      case 'resize':
        out = out.resize({
          ...(op.width !== undefined ? { width: op.width } : {}),
          ...(op.height !== undefined ? { height: op.height } : {}),
          ...(op.fit ? { fit: op.fit } : {}),
          ...(op.position ? { position: op.position } : {}),
        })
        break
      case 'rotate':
        out = op.degrees === undefined ? out.rotate() : out.rotate(op.degrees)
        break
      case 'blur':
        out = op.sigma === undefined ? out.blur() : out.blur(op.sigma)
        break
      case 'grayscale':
        out = out.grayscale()
        break
      case 'flip':
        out = out.flip()
        break
      case 'flop':
        out = out.flop()
        break
      case 'format':
        out = out[op.format](op.quality === undefined ? {} : { quality: op.quality })
        break
    }
  }
  return out
}

export interface SharpImageProcessorOptions {
  /**
   * Injectable sharp factory — the real `sharp` by default (lazy-loaded). Tests
   * pass a fake so no native binary is required.
   */
  sharp?: SharpFactory
}

/**
 * A {@link ImageProcessor} backed by [sharp](https://sharp.pixelplumbing.com).
 * Wire it into storage: `storagePlugin({ imageProcessor: new SharpImageProcessor(), ... })`.
 * `sharp` is a **peer dependency** (native `libvips`), loaded on first use so the
 * app fails fast with a clear message if it isn't installed.
 */
export class SharpImageProcessor implements ImageProcessor {
  readonly name = 'sharp'
  private factory: SharpFactory | undefined

  constructor(options: SharpImageProcessorOptions = {}) {
    this.factory = options.sharp
  }

  async run(input: Buffer, ops: ImageOp[]): Promise<Buffer> {
    const sharp = await this.load()
    return applyOps(sharp(input), ops).toBuffer()
  }

  async metadata(input: Buffer): Promise<ImageMetadata> {
    const sharp = await this.load()
    const m = await sharp(input).metadata()
    return {
      ...(m.format ? { format: m.format } : {}),
      ...(m.width !== undefined ? { width: m.width } : {}),
      ...(m.height !== undefined ? { height: m.height } : {}),
      ...(m.size !== undefined ? { size: m.size } : {}),
    }
  }

  private async load(): Promise<SharpFactory> {
    if (this.factory) return this.factory
    try {
      // Non-literal specifier: sharp is an optional peer dependency, so it is
      // resolved at runtime and never type-checked or bundled here.
      const specifier = 'sharp'
      const mod = (await import(specifier)) as { default?: SharpFactory } | SharpFactory
      const factory = (typeof mod === 'function' ? mod : (mod.default ?? mod)) as SharpFactory
      this.factory = factory
      return factory
    } catch {
      throw new Error(
        "@basaltkit/image-sharp requires the 'sharp' peer dependency. Install it with `pnpm add sharp`.",
      )
    }
  }
}
