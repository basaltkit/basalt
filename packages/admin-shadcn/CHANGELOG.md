# @basaltkit/admin-shadcn

## 1.1.0

### Minor Changes

- 36ab1a1: `defineResource` accepts field labels and enum option labels.
  
  Every label was derived from the field name through `humanize()`, which is an
  English transformation of an identifier — `taxId` reads *Tax Id*, `idDocumentNumber`
  reads *Id Document Number* — and an enum's options came out as the stored values:
  `person`, `company`, `bi`. In an application written in another language the
  generated form ends up half in English and half in database values, which is
  enough to make hand-writing the form the easier option. It is not only a
  translation problem: an English admin whose field name is the developer's name
  for the thing has it too.
  
  ```ts
  defineResource({
    name: 'contacts',
    schema: ContactSchema,
    fields: {
      taxId: { label: 'NIF' },
      kind: { label: 'Tipo', options: { person: 'Pessoa', company: 'Empresa' } },
    },
  })
  ```
  
  One map, keyed by field name, covering the table and both form modes — the same
  translation should not need three copies.
  
  **Labelling never changes what is stored.** `field.options` still holds
  `['person', 'company']`, which is what the form submits and the schema
  validates; the display text lands in a separate `field.optionLabels`, read
  through the new `optionLabel(field, value)`. Making `options` value/label pairs
  would have read better and broken every renderer, including third-party ones;
  this way a renderer that has never heard of the feature shows exactly what it
  shows today. An option left unlabelled keeps its raw value, and a key naming no
  field is ignored — a rename leaves stale entries behind, and refusing to
  describe the resource over a leftover translation would be a poor trade.
  
  `DataTable` shows the label in enum cells too: a table reading `person` beside a
  form reading *Pessoa* is worse than either alone. `formatCell` now takes a
  `Field` as well as a bare `FieldType`, which behaves as before. `ResourceForm`
  gains `chooseLabel` for an empty select's placeholder, mirroring `submitLabel` —
  the last hardcoded English string inside a translated form.

### Patch Changes

- Updated dependencies [36ab1a1]
- Updated dependencies [36ab1a1]
- Updated dependencies [d5ca076]
  - @basaltkit/admin@2.0.0

## 1.0.2

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
  - @basaltkit/admin@1.0.2

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

- @basaltkit/admin@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/admin@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/admin@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/admin@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/admin@0.20.0

## 0.19.0

### Patch Changes

- @basaltkit/admin@0.19.0

## 0.18.0

### Patch Changes

- @basaltkit/admin@0.18.0

## 0.17.0

### Patch Changes

- @basaltkit/admin@0.17.0

## 0.16.0

### Patch Changes

- @basaltkit/admin@0.16.0

## 0.15.0

### Patch Changes

- @basaltkit/admin@0.15.0

## 0.14.0

### Patch Changes

- @basaltkit/admin@0.14.0

## 0.13.0

### Patch Changes

- @basaltkit/admin@0.13.0

## 0.12.0

### Patch Changes

- @basaltkit/admin@0.12.0

## 0.11.0

### Patch Changes

- @basaltkit/admin@0.11.0

## 0.10.0

### Patch Changes

- @basaltkit/admin@0.10.0

## 0.9.0

### Patch Changes

- @basaltkit/admin@0.9.0

## 0.8.1

### Patch Changes

- @basaltkit/admin@0.8.1

## 0.8.0

### Patch Changes

- @basaltkit/admin@0.8.0

## 0.7.0

### Patch Changes

- @basaltkit/admin@0.7.0

## 0.6.0

### Patch Changes

- @basaltkit/admin@0.6.0

## 0.5.1

### Patch Changes

- @basaltkit/admin@0.5.1

## 0.5.0

### Patch Changes

- @basaltkit/admin@0.5.0

## 0.4.0

### Patch Changes

- @basaltkit/admin@0.4.0

## 0.3.0

### Patch Changes

- @basaltkit/admin@0.3.0

## 0.1.0

### Minor Changes

- Initial release: shadcn/ui-styled React components for @basaltkit/admin (Button, Input, Table, Card, Badge primitives and styled DataTable/ResourceForm).
