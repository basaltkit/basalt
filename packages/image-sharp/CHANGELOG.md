# @basaltkit/image-sharp

## 1.0.0

### Major Changes

- Initial release: a `sharp`-backed `ImageProcessor` for `@basaltkit/storage`. Provides `SharpImageProcessor` (lazy-loaded native `sharp` peer dependency) and the pure `applyOps` translator, powering the `disk.image().resize().webp().save()` pipeline. Keeps the heavy native binary out of the storage core.
