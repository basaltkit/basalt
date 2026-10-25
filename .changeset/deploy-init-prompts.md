---
'@basaltkit/deploy': patch
---

`init` at a terminal: a choice answered outside its options (`tenants`, `proxy`) is asked again instead of aborting init (three tries); the prompts no longer print a doubled `: :`; the tenants question names what it means — `Multi-tenant, each tenant on its own subdomain (<tenant>.<domain>)? subdomain | none`. Flags are unchanged: `--tenants=yes` still fails at once.
