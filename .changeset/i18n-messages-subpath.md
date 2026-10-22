---
'@basaltkit/i18n': minor
---

New subpath `@basaltkit/i18n/messages`: `defineMessages` and `render` (interpolation and plurals) with no import at all — no `@basaltkit/core`, no Node API — for browser code and CLIs that have no request context. `@basaltkit/deploy-ui` builds its page's text on it.
