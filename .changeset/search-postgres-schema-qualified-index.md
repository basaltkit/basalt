---
'@basaltkit/search-postgres': patch
---

`register()` no longer emits an invalid `CREATE INDEX` for a schema-qualified table.

`assertValidTableName` accepts `schema.table`, but `register()` built the index name by appending to it — `CREATE INDEX IF NOT EXISTS app.search_tsv_idx …`. Index names cannot be schema-qualified in Postgres, so that is a syntax error and `register()` failed outright for anyone using a non-default schema. The separator is now flattened (`app_search_tsv_idx`); the index still lands in the table's own schema, and unqualified names are byte-for-byte unchanged.
