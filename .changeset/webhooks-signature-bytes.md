---
"@basaltkit/webhooks": minor
---

`signPayload()` and `verifySignature()` now accept the body as a `string` or as bytes (`Buffer` / `Uint8Array`), so a receiver can verify the exact bytes of a `rawBody()` route — including bodies that are not valid UTF-8, such as forwarded `message/rfc822` mail — without a lossy decode. The HMAC runs over `${t}.` followed by the body bytes (a string is UTF-8 encoded), so existing string signatures are byte-identical. A body that is neither a string nor bytes now verifies as `false` (and `signPayload` throws a `TypeError`) instead of being coerced with `String()`.
