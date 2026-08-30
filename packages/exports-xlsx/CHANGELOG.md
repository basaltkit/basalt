# @basaltkit/exports-xlsx

## 1.0.2

### Patch Changes

- 104cfb3: Cells containing XML control characters no longer produce a workbook Excel refuses to open.
  
  `escapeXml` handled `& < > " '` but passed `0x00`–`0x08`, `0x0B`, `0x0C` and `0x0E`–`0x1F` straight through. XML 1.0 forbids them outright, so a single one — easily present in user-supplied data — made the whole sheet unparseable. They are now written with OOXML's `_xHHHH_` escape, and a literal `_xHHHH_` in the data is escaped first so the encoding round-trips. Tab, newline and carriage return are legal XML and stay verbatim.
- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
  - @basaltkit/exports@1.1.2

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

- @basaltkit/exports@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/exports@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/exports@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/exports@0.21.0

## 0.20.0

### Minor Changes

- 9415b25: New package: `@basaltkit/exports-xlsx` — an XLSX formatter for `@basaltkit/exports`.

  `xlsxFormatter` renders an export definition to a valid single-sheet `.xlsx` (Office Open XML SpreadsheetML) with **zero dependencies**: it ships a small STORE-method ZIP writer (with CRC32) and emits the OOXML parts by hand — headers, escaped inline strings, numeric cells, ISO dates. Register it with `exportsPlugin({ formatters: [xlsxFormatter] })` and use the `'xlsx'` format, or call `xlsxFormatter.render(headers, rows)` directly. The output passes `unzip -t` (correct CRCs) and opens in Excel/LibreOffice/Google Sheets. This is the concrete driver the `@basaltkit/exports` formatter seam was designed for. `zip()` is also exported for other OOXML/ZIP needs. Fully unit-tested, including round-tripping the archive through a minimal ZIP reader.

### Patch Changes

- @basaltkit/exports@0.20.0
