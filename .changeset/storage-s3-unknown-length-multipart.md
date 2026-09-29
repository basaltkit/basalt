---
'@basaltkit/storage-s3': minor
---

An unknown-length `putStream` no longer buffers up to `maxBytes` (audit, improvements item 7).

With no `contentLength` but a `maxBytes` cap — exactly what `@basaltkit/files` sends for an upload without a `Content-Length` (25 MiB by default) — the driver collected the whole body into one Buffer before a single `PutObject`, while the docs promised only the 64 KiB sniff window was held. It now takes the multipart path whenever `@aws-sdk/lib-storage` is installed, cap or no cap: at most `partSizeBytes × queueSize` (20 MiB by default) is in memory, a body smaller than one part is one `PutObject` of that part, and the cap is still enforced mid-stream by the Disk. Only without the optional peer does an unknown length fall back to one buffered `PutObject` under `maxBytes` (documented as such), or `STORAGE_STREAM_LENGTH_REQUIRED` with no cap.
