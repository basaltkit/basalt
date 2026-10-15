---
'@basaltkit/deploy-ui': minor
---

`--pair` for shared machines (RFC 0009 Q1): the browser opens the bare URL and you type an 8-character pairing code the terminal shows, so no secret passes through the opener's or the browser's command line, which other local users can read. The code has no look-alike letters, accepts any case, spaces and the dash, lasts 2 minutes and allows 5 tries before the session locks. Without a session, the page now asks for the code (a pasted launch code works too). An expired code answers 410.
