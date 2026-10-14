---
'@basaltkit/deploy': patch
---

`passEnv` hands compose the value the env step just wrote. When a deploy changed a passed key (a recreated Redis, a generated URL), the service got the `.env` from before the change and could not authenticate.
