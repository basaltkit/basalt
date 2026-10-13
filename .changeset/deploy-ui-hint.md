---
'@basaltkit/deploy': patch
---

`basalt-deploy ui` prints how to start the local UI (`@basaltkit/deploy-ui`, RFC 0009) on the operator's machine, and exits 0; with `--json` it is refused (`unsupported`). It loads no config and spawns nothing: the package gains no listener and no dependency.
