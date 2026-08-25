# @basaltkit/image-sharp

## 1.1.0

### Minor Changes

- 8a05e6d: Security: require `sharp >= 0.35.0` (peer dependency). Versions below 0.35.0
  inherit HIGH-severity libvips vulnerabilities ([GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj)).
  Upgrade your `sharp` install to 0.35.x.

## 1.0.0

### Major Changes

- Initial release: a `sharp`-backed `ImageProcessor` for `@basaltkit/storage`. Provides `SharpImageProcessor` (lazy-loaded native `sharp` peer dependency) and the pure `applyOps` translator, powering the `disk.image().resize().webp().save()` pipeline. Keeps the heavy native binary out of the storage core.
