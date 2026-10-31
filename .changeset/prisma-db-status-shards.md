---
'@basaltkit/prisma': minor
---

`dbStatusCommand({ shards: { urls } })` checks every shard of a `ShardRouter` too. `prisma migrate dev`/`status` only see `DATABASE_URL`, so a shard could fall behind while the central database reported "up to date", and a tenant's request failed on its shard with `P2021`. Each shard gets its own line (`shard 0`, `shard 1`, … — URLs never printed) and a pending one says to run `prisma migrate deploy` with `DATABASE_URL` set to it; `--json` rows carry `plane: 'shard'` and `shard`.
