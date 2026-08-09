# Versioning

## Lockstep for `@basaltkit/*`

All `@basaltkit/*` packages are versioned **in lockstep** — they always share the
same version number and are released together. This is enforced by the
changesets configuration:

```jsonc
// .changeset/config.json
"fixed": [["@basaltkit/*"]]
```

A changeset touching any `@basaltkit/*` package bumps **every** `@basaltkit/*`
package to the same new version. This deliberately avoids the semver-0.x
footgun where `^0.1.0` (which resolves to `>=0.1.0 <0.2.0`) silently excludes a
minor bump in a sibling package: because every package moves together, an app
can pin a single range for the whole toolkit and always get a compatible set.

`create-basalt` is **not** part of the group — the scaffolder has its own
release cadence, and pins the `@basaltkit/*` line it scaffolds via a single
`BASALT_VERSION` constant (with a temporary per-package override only while a
package is briefly ahead of the line; see `packages/create-app/src/templates.ts`).

## Release flow

Releases are automated with [changesets](https://github.com/changesets/changesets):

1. A change lands with a changeset (`pnpm changeset`).
2. The **Release** workflow opens a "Version Packages" PR that applies the
   version bumps and updates changelogs.
3. Merging that PR publishes to npm — with **provenance**
   (`NPM_CONFIG_PROVENANCE`) via a `NPM_TOKEN`, so no interactive OTP.

## Toward 1.0

The API is still `0.x`; minors may include breaking changes, called out in the
changelog. On the road to `1.0` the lockstep line stabilizes, at which point
standard semver caret ranges (`^1`) apply across the toolkit.
