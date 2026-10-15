---
'@basaltkit/deploy': patch
---

`bootstrap` refuses to install a pnpm older than 9.0.0 globally as root (the app user's `packageManager`/lockfile picks the version; root now sets the floor). The root tool check is documented as a guard against running the wrong copy, not a defence against a tampered one.
