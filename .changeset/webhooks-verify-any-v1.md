---
'@basaltkit/webhooks': patch
---

`verifySignature` now accepts a header with several `v1=` signatures and returns `true` when any of them matches, so receivers keep verifying while a sender rotates its secret (signing with both the new and the old one). Previously only the last `v1` was checked. Parsing is also stricter and more tolerant: a duplicate `t` is rejected, unknown schemes and spaces after commas are ignored.
