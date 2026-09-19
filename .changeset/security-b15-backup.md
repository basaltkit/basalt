---
"@basaltkit/backup": minor
---

Security hardening for PostgreSQL backups:

- Database passwords are no longer passed to `pg_dump`/`pg_restore` on the command line; they are handed to the tool through `PGPASSWORD` (new `options.env` on `CommandRunner`, which custom runners must forward). Failure messages record only the tool name and exit code with credentials scrubbed, and a tenant `databaseUrl` is redacted before it is written to manifests or logs. Credentials are also scrubbed from extra error properties that loggers serialize (for example `cmd` on `execFile` errors and `input` on invalid-URL errors), and from non-`Error` string rejections.
- `restore()` now verifies the manifest's canonical artifact path and the recorded SHA-256 checksum before running `pg_restore`, throwing the new `BackupIntegrityError` on mismatch. Retention pruning deletes only canonical artifact keys.
