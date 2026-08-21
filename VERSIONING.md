# Versioning

Basalt uses a **two-tier** model.

## 1. Each `@basaltkit/*` package is versioned independently

Every package follows [semver](https://semver.org) on its **own** cadence: it
bumps only when *it* changes. So `@basaltkit/subscriptions` may be at `2.x` while
`@basaltkit/core` is still `1.x`. Depend on each with a caret range (`^1`); every
package is built and tested against the current `@basaltkit/core`.

The exact, current version of every package is on the auto-generated
[**Ecosystem**](https://basaltkit-docs.pages.dev/guide/ecosystem) docs page.

> Packages are **not** released in lockstep. (An earlier changesets
> `fixed: [["@basaltkit/*"]]` config implied that; it was removed because it never
> matched how the packages actually version on npm.)

`create-basalt` (the scaffolder) also versions independently and pins the
`@basaltkit/*` line it scaffolds.

## 2. One umbrella "Basalt release" version

For **communication and documentation** the framework has a single
generation marker — e.g. **Basalt 1.1** (the number shown in the docs nav). It is
**not** any single package's version: `1.0` was the first stable release, `1.1`
the security-hardening wave.

Single source of truth: the `version` field in the **private root
`package.json`** (unpublished). The VitePress config reads it and renders the nav
chip, so the docs never drift from it. To mark a new generation, bump that field.

## Release flow

Each changed package is versioned (its own semver bump) and published to npm
independently; a [changeset](https://github.com/changesets/changesets) captures
the changelog entry for the change. Publishing uses npm with provenance.

## Semver commitment

As of the `1.0` release the public API is stable: breaking changes only in a new
**major**, features in a **minor**, fixes in a **patch**. Error codes, public
events and config names are part of the API.
