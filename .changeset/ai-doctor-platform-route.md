---
'@basaltkit/ai': patch
---

`basalt ai doctor` gains the `platform-route-accepts-tenant` rule (BK-043): it scans `src/**` for route `meta` literals that pair `tenant: false` with a `can: 'platform:…'` permission and warns, naming file and line, that the route still runs on tenant hosts — declare `tenant: 'never'` instead. `ProjectReader` gets an optional `list(dir)` method (implemented by `nodeReader` and `memoryReader`); readers without it skip the scan.
