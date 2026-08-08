# Versioning & compatibility

What Machize promises about versions, runtimes, and change — so you can depend on
it without surprises.

[[toc]]

## Semantic versioning

Every `@machize/*` package follows [semver](https://semver.org). While the
ecosystem is **pre-1.0** (`0.x`), the API is stable in practice and each release
is tested, but minor versions may still make small breaking changes as the
surface is finalized — pin a version if that matters to you. Once **1.0** ships,
the guarantee is the usual one: breaking changes only in a new **major**, new
features in a **minor**, fixes in a **patch**.

## Lockstep versions

The packages are released **in lockstep**: every `@machize/*` package shares the
same version and is published together (via Changesets, `fixed: [["@machize/*"]]`).
So `@machize/auth@0.31.0` is built and tested against `@machize/core@0.31.0` —
keep them on the same version. The `create-machize` scaffolder versions
independently.

::: tip Why lockstep
The packages are one integrated framework, not independent libraries. Lockstep
means any combination you install was tested together — no version-matrix
guesswork.
:::

## Runtime support

| Aspect | Policy |
| --- | --- |
| **Node.js** | **22 or newer.** CI tests on Node 22 and 24. |
| **`node:sqlite` stores** | The `*-sqlite` store packages need **Node 22.5+**; stable and flag-free on Node 24, and on 22.x they require `--experimental-sqlite`. They declare `engines.node >= 22.5.0`. |
| **Modules** | **ESM only.** Every package ships `"type": "module"` with `import`-only exports — there is no CommonJS build. Use ESM (or a bundler) in your app. |
| **TypeScript** | Types ship with every package. `exactOptionalPropertyTypes` and the strict family are honored, so the types are safe to consume under strict mode. |
| **Package manager** | The repo uses pnpm, but any manager works to consume the published packages. |

If you don't use the `*-sqlite` packages, Node 22+ is enough; those are the only
packages that require 22.5+.

## Deprecation policy (from 1.0)

Once 1.0 ships, nothing in the public API is removed without warning:

1. A symbol slated for removal is marked `@deprecated` in its JSDoc, with the
   replacement named, in a **minor** release.
2. It keeps working for the rest of the `1.x` line.
3. It is only removed in the **next major** (`2.0`).

"Public API" means every top-level export of a package. Anything marked
`@internal`, or not exported from the package entry point, is not covered by this
policy and may change at any time.

## Upgrading 0.x → 1.0

The road to 1.0 is [tracked in the repo](https://github.com/Zebedeu/machize/blob/main/RELEASE_1.0_CHECKLIST.md).
The intent is that **1.0 is a stability commitment, not a rewrite** — the API you
use at the latest `0.x` is the API you'll have at `1.0`. When 1.0 is cut, the
release notes will list any breaking change explicitly; if this note still says
so, none are expected beyond what the checklist's API review may surface. To be
ready:

- Move off any symbol already marked `@deprecated` in your current version.
- Pin to a single `@machize/*` version across your dependencies (they release in
  lockstep).
- If you use the durable stores, you're already on the 1.0 shape — the store
  contracts are frozen and won't change at 1.0.

## Security & supported versions

Pre-1.0, security fixes land on the latest published minor — upgrade to the
newest `0.x` to receive them. See [SECURITY.md](https://github.com/Zebedeu/machize/blob/main/SECURITY.md)
for the disclosure process.
