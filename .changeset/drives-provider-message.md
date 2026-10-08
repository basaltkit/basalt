---
"@basaltkit/drives": minor
"@basaltkit/drives-dropbox": minor
"@basaltkit/drives-google": minor
"@basaltkit/drives-microsoft": minor
---

Provider error explanations are no longer thrown away. `DriveProviderError`, `DriveAccessDeniedError` and `DriveCredentialsInvalidError` accept an optional `{ providerMessage }`, carried only on the non-enumerable, log-only `internalDetails` channel (read by `@basaltkit/http`'s error reporter and `internalDetailsOf()`), never in `message`, `details`, hook payloads or the response body. The adapters fill it from allow-listed fields only — Google/Graph `error.message` / `error_description`, Dropbox `user_message.text`, a `missing_scope` error's `required_scope`, or a Dropbox `400 text/plain` body — through the new `providerMessageOf()` helper, which strips control/bidi characters, redacts URL/bearer/JWT/token-shaped text and truncates to 500 characters.
