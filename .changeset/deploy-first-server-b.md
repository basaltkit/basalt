---
"@basaltkit/deploy": minor
---

Two more gaps from a first real server:

- **Answers are checked against the app's schema at the question.** With `env.schema` set, each `ask` answer runs through the app's `src/env.ts` as soon as it is typed. If the schema refuses it, the question is asked again (up to three tries). Only that key's issues count, and the warning repeats the schema's rule, never the value. A 31-character token the schema wants at 32 used to pass the question and fail only at validate.
- **`init --server` pins the pm2 port behind Apache.** The vhost names the port and is written before the first deploy, so an `auto` port picked at deploy time might not be the one it says. `init` now writes `pm2({ port })`: the loopback port the domain's existing vhost proxies to, or else the first port free on the server now. A comment names it. Caddy keeps `auto` with `avoid`, since it writes its own site.
