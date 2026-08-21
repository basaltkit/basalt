import type { PutOptions } from './driver.js'
import { ImageProcessingUnavailableError } from './errors.js'

/** Output encodings the pipeline can request. */
export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'avif'

export interface ResizeOptions {
  width?: number
  height?: number
  /** How the image fills the target box. Default (engine's choice): `cover`. */
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside'
  /** Gravity/position for `cover`/`contain` (engine-specific string, e.g. `center`). */
  position?: string
}

/**
 * A single, serializable pipeline step. Kept engine-neutral so any
 * {@link ImageProcessor} (sharp today, another engine tomorrow) can execute it.
 */
export type ImageOp =
  | ({ op: 'resize' } & ResizeOptions)
  | { op: 'rotate'; degrees?: number }
  | { op: 'blur'; sigma?: number }
  | { op: 'grayscale' }
  | { op: 'flip' }
  | { op: 'flop' }
  | { op: 'format'; format: ImageFormat; quality?: number }

export interface ImageMetadata {
  format?: string
  width?: number
  height?: number
  /** Byte size of the source image, when known. */
  size?: number
}

/**
 * Image engine contract. `@basaltkit/storage` ships only this interface and the
 * fluent {@link ImagePipeline}; a concrete engine (e.g. `@basaltkit/image-sharp`,
 * a native `sharp` peer) is injected via `storagePlugin({ imageProcessor })`.
 * This keeps the core free of a heavy native dependency (see ARCHITECTURE §9.1).
 */
export interface ImageProcessor {
  readonly name: string
  /** Applies `ops` in order to `input`, returning the encoded result. */
  run(input: Buffer, ops: ImageOp[]): Promise<Buffer>
  /** Reads dimensions/format without re-encoding. */
  metadata(input: Buffer): Promise<ImageMetadata>
}

const MIME: Record<ImageFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
}

/**
 * Fluent, engine-agnostic image pipeline. Steps are collected lazily and run
 * only when a terminal (`toBuffer` / `save` / `metadata`) is awaited:
 *
 * ```ts
 * await disk.image('avatars/1.png').resize(256, 256).webp(80).save('avatars/1.webp')
 * const meta = await disk.image('hero.jpg').metadata()
 * ```
 */
export class ImagePipeline {
  private readonly ops: ImageOp[] = []

  constructor(
    private readonly source: () => Promise<Buffer>,
    private readonly processor: ImageProcessor | undefined,
    /** Present only for disk-backed pipelines; enables `save()`. */
    private readonly saver?: (path: string, content: Buffer, options?: PutOptions) => Promise<void>,
  ) {}

  resize(width?: number, height?: number, options: Omit<ResizeOptions, 'width' | 'height'> = {}): this {
    this.ops.push({
      op: 'resize',
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...options,
    })
    return this
  }

  rotate(degrees?: number): this {
    this.ops.push(degrees === undefined ? { op: 'rotate' } : { op: 'rotate', degrees })
    return this
  }

  blur(sigma?: number): this {
    this.ops.push(sigma === undefined ? { op: 'blur' } : { op: 'blur', sigma })
    return this
  }

  grayscale(): this {
    this.ops.push({ op: 'grayscale' })
    return this
  }

  flip(): this {
    this.ops.push({ op: 'flip' })
    return this
  }

  flop(): this {
    this.ops.push({ op: 'flop' })
    return this
  }

  webp(quality?: number): this {
    return this.format('webp', quality)
  }
  jpeg(quality?: number): this {
    return this.format('jpeg', quality)
  }
  png(quality?: number): this {
    return this.format('png', quality)
  }
  avif(quality?: number): this {
    return this.format('avif', quality)
  }

  /** Sets the output encoding (and optional quality). */
  format(format: ImageFormat, quality?: number): this {
    this.ops.push(quality === undefined ? { op: 'format', format } : { op: 'format', format, quality })
    return this
  }

  /** Runs the pipeline and returns the encoded bytes. */
  async toBuffer(): Promise<Buffer> {
    return this.engine().run(await this.source(), this.ops)
  }

  /** Reads source metadata without applying the queued ops. */
  async metadata(): Promise<ImageMetadata> {
    return this.engine().metadata(await this.source())
  }

  /**
   * Runs the pipeline and writes the result back to the disk (tenant scope, key
   * guard and upload limits all apply, since this delegates to `disk.put`). The
   * content type is inferred from the last format op unless overridden.
   */
  async save(path: string, options: PutOptions = {}): Promise<void> {
    if (!this.saver) {
      throw new ImageProcessingUnavailableError('save() is only available on a disk-backed pipeline (disk.image()).')
    }
    const output = await this.toBuffer()
    const contentType = options.contentType ?? this.outputContentType()
    await this.saver(path, output, contentType ? { ...options, contentType } : options)
  }

  /** The queued operations — for introspection and testing. */
  get pipeline(): readonly ImageOp[] {
    return this.ops
  }

  private engine(): ImageProcessor {
    if (!this.processor) throw new ImageProcessingUnavailableError()
    return this.processor
  }

  private outputContentType(): string | undefined {
    for (let i = this.ops.length - 1; i >= 0; i--) {
      const op = this.ops[i]!
      if (op.op === 'format') return MIME[op.format]
    }
    return undefined
  }
}
