# @basaltkit/image-sharp

**Image processing engine** for [`@basaltkit/storage`](https://www.npmjs.com/package/@basaltkit/storage), backed by [sharp](https://sharp.pixelplumbing.com). It implements the storage `ImageProcessor` contract so `disk.image(...)` can resize, rotate, and re-encode to WebP/AVIF/JPEG/PNG.

You need this module only when you actually process images. The core `@basaltkit/storage` ships the fluent pipeline and the contract, but **no native dependency** — the heavy `sharp`/`libvips` binary lives here, as an opt-in satellite (see the framework's ARCHITECTURE §9.1).

## Installation

```bash
pnpm add @basaltkit/image-sharp sharp
```

`sharp` is a **peer dependency** (it carries the native `libvips` binary). It's loaded lazily on first use, so a missing install fails fast with a clear message instead of at import time.

## Usage

Wire the engine once, then use `disk.image(...)` anywhere:

```ts
import { storagePlugin } from '@basaltkit/storage'
import { SharpImageProcessor } from '@basaltkit/image-sharp'

storagePlugin({
  imageProcessor: new SharpImageProcessor(),
  disks: { uploads: { driver: 'local', root: './storage' } },
})
```

```ts
// resize + re-encode + write back to the disk (tenant scope + key guard apply)
await storage.disk('uploads')
  .image('avatars/1.png')
  .resize(256, 256, { fit: 'cover' })
  .webp(80)
  .save('avatars/1.webp')

// or just get the bytes
const thumb = await storage.disk('uploads').image('hero.jpg').resize(320).jpeg().toBuffer()

// read dimensions without re-encoding
const { width, height, format } = await storage.disk('uploads').image('hero.jpg').metadata()
```

Do heavy work inside a `@basaltkit/queue` job so it never blocks the request.

## Pipeline operations

| Method | sharp call | Notes |
|---|---|---|
| `.resize(width?, height?, { fit?, position? })` | `resize()` | Omit a dimension to scale by aspect ratio |
| `.rotate(degrees?)` | `rotate()` | No argument → auto-orient from EXIF |
| `.blur(sigma?)` | `blur()` | |
| `.grayscale()` / `.flip()` / `.flop()` | same | |
| `.webp(q?)` `.jpeg(q?)` `.png(q?)` `.avif(q?)` | encoder | Sets the output format (+ quality) |
| `.format(fmt, q?)` | encoder | Dynamic form of the above |

Terminals: `.toBuffer()`, `.save(path, options?)`, `.metadata()`.

## API

### `class SharpImageProcessor`

`new SharpImageProcessor({ sharp? })` — implements `ImageProcessor` from `@basaltkit/storage`. Pass a `sharp` factory to inject a fake in tests; by default the real `sharp` is lazy-loaded.

### `applyOps(image, ops)`

The pure op-list → sharp-call translator, exported for testing and advanced embedding.

## How it connects

`@basaltkit/storage` owns `disk.image(...)`, the fluent `ImagePipeline`, and the `ImageProcessor` interface. This package is one implementation of that interface — swap it for another engine without touching app code.

## License

MIT
