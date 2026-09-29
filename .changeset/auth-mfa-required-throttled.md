---
"@basaltkit/auth": minor
---

`login()` now counts an `AUTH_MFA_REQUIRED` answer against the per-account and per-IP login throttles, exactly like a wrong password. That answer is only returned for a correct password, so on MFA accounts it is a password oracle; before, it released both reservations and allowed unthrottled password guessing through it. The legitimate two-step flow is unaffected — the successful sign-in with the code clears the account counter — but each MFA login's first, code-less step now spends one per-IP slot until the window expires, so size `ipLoginThrottle` for large shared-NAT populations. Documented in the README and guide security notes.
