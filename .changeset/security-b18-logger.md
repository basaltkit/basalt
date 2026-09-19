---
'@basaltkit/logger': minor
---

Security: default log redaction now walks every logged object and child binding recursively (any depth, arrays, logged errors including `cause` and `AggregateError` members, `toJSON()` carriers such as axios headers, and class instances; cycle-safe and bounded) and matches secret-bearing key names case- and separator-insensitively, so API-key headers, response `set-cookie`, snake_case OAuth tokens and stored credentials such as `passwordHash`, `mfaSecret` and `client_secret` no longer reach the logs. Class instances under the top-level `req`/`res` keys are left to their serializers.

Behaviour change: fields whose normalised name matches a secret name or suffix now log as `[REDACTED]` at any depth — including `sessionId`, `csrfToken`, `tokens`, `apiKeys`, `recoveryCodes` and `*Key`-style secrets (`signingKey`, `encryptionKey`). Nesting beyond 10 levels logs as `[Truncated]`, cycles as `[Circular]`.
