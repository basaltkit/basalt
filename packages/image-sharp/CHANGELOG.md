# @basaltkit/image-sharp

## 1.1.2

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
  - @basaltkit/storage@1.3.1

## 1.1.0

### Minor Changes

- 8a05e6d: Security: require `sharp >= 0.35.0` (peer dependency). Versions below 0.35.0
  inherit HIGH-severity libvips vulnerabilities ([GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj)).
  Upgrade your `sharp` install to 0.35.x.

## 1.0.0

### Major Changes

- Initial release: a `sharp`-backed `ImageProcessor` for `@basaltkit/storage`. Provides `SharpImageProcessor` (lazy-loaded native `sharp` peer dependency) and the pure `applyOps` translator, powering the `disk.image().resize().webp().save()` pipeline. Keeps the heavy native binary out of the storage core.
