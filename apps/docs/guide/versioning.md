# Versioning & compatibility

What Basalt promises about versions, runtimes, and change — so you can depend on
it without surprises.

[[toc]]

## Semantic versioning

Every `@basaltkit/*` package follows [semver](https://semver.org). As of **1.0**,
the public API is **stable**: breaking changes only in a new **major**, new
features in a **minor**, and fixes in a **patch**. You can depend on a `^1`
range and get features and fixes without breakage until the next major.

## Lockstep versions

The packages are released **in lockstep**: every `@basaltkit/*` package shares the
same version and is published together (via Changesets, `fixed: [["@basaltkit/*"]]`).
So `@basaltkit/auth@1.0.0` is built and tested against `@basaltkit/core@1.0.0` —
keep them on the same version. The `create-basalt` scaffolder versions
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

## Deprecation policy

Now that 1.0 has shipped, nothing in the public API is removed without warning:

1. A symbol slated for removal is marked `@deprecated` in its JSDoc, with the
   replacement named, in a **minor** release.
2. It keeps working for the rest of the `1.x` line.
3. It is only removed in the **next major** (`2.0`).

"Public API" means every top-level export of a package. Anything marked
`@internal`, or not exported from the package entry point, is not covered by this
policy and may change at any time.

## Upgrading from 0.x

**1.0 is a stability commitment, not a rewrite** — it's functionally identical to
`0.32.0`, with no breaking changes. Moving from any recent `0.x`:

- Bump every `@basaltkit/*` dependency to `1.0.0` together (they release in
  lockstep) and pin a `^1` range going forward.
- If you're on the durable stores, nothing changes — the store contracts were
  already at their 1.0 shape and are now frozen.
- That's it. From here, `^1` gets you features and fixes without breakage.

## Security & supported versions

Security fixes land on the latest `1.x` minor — upgrade to the newest `1.x` to
receive them. See [SECURITY.md](https://github.com/Zebedeu/basalt/blob/main/SECURITY.md)
for the disclosure process.
