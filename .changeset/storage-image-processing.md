---
"@basaltkit/storage": minor
---

Add image processing via a fluent, engine-neutral pipeline.

- **`disk.image(path)`** returns an `ImagePipeline`: `.resize(w?, h?, { fit?, position? })`, `.rotate()`, `.blur()`, `.grayscale()`, `.flip()`, `.flop()`, and encoders `.webp()/.jpeg()/.png()/.avif()`, with terminals `.toBuffer()`, `.metadata()`, and `.save(path)`. `save()` delegates to `disk.put`, so tenant scope, the key guard, and upload limits all apply; the content type is inferred from the output format.
- **`ImageProcessor`** contract + `ImageOp`/`ImageFormat`/`ImageMetadata`/`ResizeOptions` types. The engine is injected via `storagePlugin({ imageProcessor })` — the new `@basaltkit/image-sharp` satellite provides a `sharp`-backed one, keeping the native binary out of the storage core.
- New `ImageProcessingUnavailableError` (`STORAGE_IMAGE_UNAVAILABLE`) when a pipeline terminal runs with no engine configured.
