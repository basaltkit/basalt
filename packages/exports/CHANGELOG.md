# @machize/exports

## 0.24.0

### Patch Changes

- @machize/core@0.24.0

## 0.23.0

### Patch Changes

- @machize/core@0.23.0

## 0.22.0

### Patch Changes

- @machize/core@0.22.0

## 0.21.0

### Patch Changes

- @machize/core@0.21.0

## 0.20.0

### Patch Changes

- @machize/core@0.20.0

## 0.19.0

### Patch Changes

- @machize/core@0.19.0

## 0.18.0

### Patch Changes

- @machize/core@0.18.0

## 0.17.0

### Patch Changes

- @machize/core@0.17.0

## 0.16.0

### Patch Changes

- @machize/core@0.16.0

## 0.15.0

### Minor Changes

- 09a5fd6: New package: `@machize/exports` — data exports and reporting.

  `defineExport<T>({ name, columns })` declares a typed export (each column has a `header` and a `value(row)`), and `Exports.run(def, data, format)` renders it to a file, returning `{ content, contentType, filename, format, rowCount }`. Native formatters — `csv`, `tsv` (RFC-4180 quoting, CRLF, ISO dates), `json`, `ndjson` — need no dependencies; a pluggable `ExportFormatter` seam lets XLSX/PDF drivers register via `exportsPlugin({ formatters })`. `run` accepts an array or an `AsyncIterable`, so rows can be streamed from the database, and it's pure/synchronous by design — run it inside a `@machize/queue` job and store the result with `@machize/files`/`@machize/storage` for large reports. Fully unit-tested — escaping, every native format, async iterables, custom formatters, and the plugin.

### Patch Changes

- @machize/core@0.15.0
