# @basaltkit/exports

## 1.1.2

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
  - @basaltkit/core@1.3.1

## 1.1.0

### Minor Changes

- Security: **CSV/TSV export neutralizes spreadsheet formula injection.** A string cell beginning with `=`, `+`, `-`, `@`, or a leading tab/CR is a formula a spreadsheet evaluates on open — so an exported value like `=WEBSERVICE(...)` could exfiltrate data or run a command on the recipient's machine. Such string cells are now prefixed with a single quote so the spreadsheet renders them as text. Numbers and dates are untouched (a negative number stays `-5`).

## 1.0.5

### Patch Changes

- Lockstep 1.0.5 release. No code changes in this package; it moves with the
  ecosystem-wide durable/Redis backend expansion (tenancy, events outbox,
  webhooks, rate-limiting, idempotency). Internal `@basaltkit/*` dependencies now
  use caret ranges (`workspace:^`).

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@basaltkit/*` ecosystem.

## 0.24.0

### Patch Changes

- @basaltkit/core@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/core@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/core@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/core@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/core@0.20.0

## 0.19.0

### Patch Changes

- @basaltkit/core@0.19.0

## 0.18.0

### Patch Changes

- @basaltkit/core@0.18.0

## 0.17.0

### Patch Changes

- @basaltkit/core@0.17.0

## 0.16.0

### Patch Changes

- @basaltkit/core@0.16.0

## 0.15.0

### Minor Changes

- 09a5fd6: New package: `@basaltkit/exports` — data exports and reporting.

  `defineExport<T>({ name, columns })` declares a typed export (each column has a `header` and a `value(row)`), and `Exports.run(def, data, format)` renders it to a file, returning `{ content, contentType, filename, format, rowCount }`. Native formatters — `csv`, `tsv` (RFC-4180 quoting, CRLF, ISO dates), `json`, `ndjson` — need no dependencies; a pluggable `ExportFormatter` seam lets XLSX/PDF drivers register via `exportsPlugin({ formatters })`. `run` accepts an array or an `AsyncIterable`, so rows can be streamed from the database, and it's pure/synchronous by design — run it inside a `@basaltkit/queue` job and store the result with `@basaltkit/files`/`@basaltkit/storage` for large reports. Fully unit-tested — escaping, every native format, async iterables, custom formatters, and the plugin.

### Patch Changes

- @basaltkit/core@0.15.0
