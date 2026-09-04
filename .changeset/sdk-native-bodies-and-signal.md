---
'@basaltkit/sdk': patch
---

Send native request bodies as-is, and accept an `AbortSignal` and per-call
headers.

The client always serialised to JSON: it declared `content-type:
application/json` and called `JSON.stringify` on whatever it was given. Right
for the common case, wrong for the one the platform already solves — a
`FormData` upload, where `JSON.stringify(formData)` is `"{}"` and the browser
has to write the multipart boundary itself, which it only does when
`content-type` is left alone.

`FormData`, `Blob`, `ArrayBuffer`, `ReadableStream` and `URLSearchParams` now
pass through untouched, with no content-type imposed. Plain objects are still
JSON.

`CallInput` also takes `signal` and `headers`. Without a signal, a
search-as-you-type field fires one request per keystroke and can call none of
them off — the last answer to arrive wins, which is not the same as the last one
asked for. Per-call headers merge over the client's; the narrower scope wins,
the same rule as everywhere else in the client.

No change for existing calls: both fields are optional and JSON bodies behave
exactly as before.
