---
'@basaltkit/audit': major
---

Framework audit residuals: `verifyAll()` coverage and `audit:verify --all=true`.

- **`verifyAll()` visits tenants that have rows but no chain.** It used to verify only tenants listed by `chainTenants()`, so a tenant whose only rows were forged seq-less inserts was never checked. Such tenants are now verified too; their legacy cut-off defaults to the moment integrity began for the whole store (the earliest first entry of any chain), so a row written after it fails with `unchained-entry`. An explicit `legacyUntil` applies to them as well. The tenant list comes from the new optional `AuditStore.auditTenants()` (implemented by `MemoryAuditStore`); a store without it is scanned through `query({})`.
- **`audit:verify` parses its flags strictly.** `--all=true` (a string) used to be read as "not `--all`": it verified only the system chain and exited 0. `--all`, `--all=true|1|yes` now verify every chain, `--all=false|0|no` a single one, and any other value throws. `--all` combined with `--tenant`/`--from`/`--to`/`--expected-head` throws, and `--tenant` without a value throws instead of silently verifying the system chain.

**Why major:** `verifyAll()` / `audit:verify --all` can now report `ok: false` (exit 1) for a trail they used to pass, and flag combinations that were silently ignored now throw. Migration: if old replicas wrote unchained rows for tenants that never got a chain after integrity was enabled, pass `legacyUntil` (the timestamp the rollout finished). Custom stores should implement `auditTenants()` (`SELECT DISTINCT tenant_id`) to avoid the full scan.
