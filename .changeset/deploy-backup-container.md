---
'@basaltkit/deploy': patch
---

`backup.container`: with external infra, the pre-migration `pg_dump` runs inside the named Postgres container (`docker exec`, password in the environment only), with a preflight check that the container is running and a matching restore command. The public health check now prints its URL when it passes.
