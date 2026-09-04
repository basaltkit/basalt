---
'@basaltkit/admin': patch
---

Drop the `node:crypto` import so the package bundles for the browser.

`memoryDataSource` used `randomUUID` from `node:crypto` to mint an id, and the
barrel re-exports that module — so importing `defineResource` pulled a Node
builtin into the bundle. This package is the engine two React bindings render;
its destination is the browser, and bundlers failed outright:

```
"randomUUID" is not exported by "__vite-browser-external"
```

Every consuming application had to alias `node:crypto` to a shim of its own.

The id now comes from `globalThis.crypto.randomUUID()` where it exists, with a
counter fallback. Not `crypto.randomUUID()` alone: that requires a secure
context and is undefined on plain http — how a developer reaches a dev server
from a phone on the local network — so it would have moved the failure rather
than removed it. Ids from an in-memory source need only be unique within one
process.

`node:crypto` was the only Node builtin in the package, so the whole entry point
is now isomorphic. A test asserts that no file under `src` imports from `node:`,
because that failure surfaces in the consumer's bundler, far from the line that
caused it.
