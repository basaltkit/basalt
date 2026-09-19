---
'@basaltkit/hono': minor
'@basaltkit/express': minor
'@basaltkit/mailer-smtp': patch
---

Security hardening for the Express and Hono adapters.

- `@basaltkit/hono`: `request.ip` is now populated from the socket address (`@hono/node-server`, Bun) or a new `getClientIp` option, so per-client rate limiting and the IP login throttle work; a one-time warning is printed when no IP can be resolved.
- `@basaltkit/hono`: `bodyLimit` is now enforced on the bytes actually read, including chunked/streamed bodies without `Content-Length`.
- `@basaltkit/hono`: error responses keep the security and CORS headers set by pre-hooks; the 413 body now uses the standard `{ error: { code, message } }` envelope (was a flat `{ code, message }`).
- `@basaltkit/express`: a final error middleware (opt out with `errorHandler: false`) answers body-parser and pre-hook errors with the neutral JSON envelope instead of an HTML stack trace; async pre-hook and edge-route errors are forwarded on Express 4.
- Peer floors raised to versions without known advisories: `express ^4.22.3 || ^5.2.1`, `hono ^4.13.5`, `nodemailer ^9.1.1 || ^10.0.0`.
