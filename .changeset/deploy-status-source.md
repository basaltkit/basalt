---
'@basaltkit/deploy': minor
---

`status` says where the code comes from. The JSON result adds `source: { remote, branch, url? }`, and the human output prints `source: origin/main (github.com/acme/app)`. The address is reduced to `host[:port]/path`: no scheme, credentials, query, fragment or `.git`. A local path or anything outside a plain host-and-path grammar gives no `url`. The git call is bounded and never stops `status`. This is additive within protocol v1.
