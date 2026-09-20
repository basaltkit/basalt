---
'@basaltkit/drives': minor
---

Drives phase-2 audit: one credential leak, one silent data-loss bug, and three
places the contract was less honest than the adapters.

**A provider download URL could reach an error, a log and the audit trail
(security).** `createDriveFetch` let `@basaltkit/webhooks`' `WebhookUrlBlockedError`
propagate, and that error's message is `Refusing to deliver webhook to <the full
URL>: <reason>` — correct for an endpoint an operator configured, wrong here.
On the download path the URL being validated *is* a bearer credential for the
file (`@microsoft.graph.downloadUrl`, Google's signed `googleusercontent.com`
redirect target), and `syncConnection` forwards `error.message` verbatim into
`drive:sync_failed`, which is exactly what apps route to their logger and to
`@basaltkit/audit`. It needed no attacker: a DNS hiccup on the CDN host was
enough, on a path that runs for every single download. The guarded fetch now
re-raises every URL-validation failure as `DriveHostNotAllowedError`, which
carries the **host and a fixed reason and never the URL** — and no `cause`,
because a cause chain puts the message straight back into anything that
serialises the error. `new URL()` failures are wrapped too (`ERR_INVALID_URL`
carries the offending string on `error.input`). `DriveHostNotAllowedError` takes
an optional `reason`, so a refusal still says whether it was the allowlist, the
address or the parse.

**A first sync bigger than one run's ceiling imported nothing past it
(correctness).** For an adapter with `deltaIncludesExisting: false` — Google,
the vendor with the largest corpora — a truncated backfill cleared the cursor,
and the listing page cursor was local to the run. Every subsequent run therefore
re-walked the same first page, reported `truncated: true` as though it were
making progress, never imported anything beyond `maxItems`/`maxPages`, and never
reached the change feed. `syncConnection` now parks its own resume point in
`connection.cursor` and continues the enumeration across runs, adopting the
delta cursor only once the walk has actually finished. The resume point holds
the delta cursor taken **before the first** listing page, so the at-least-once
argument survives resumption; an unreadable one is recognised by its prefix and
restarts the walk rather than falling through to the feed.

**`drive:disconnected` now says what happened, not just whether it happened.**
The payload gains `revocation: 'revoked' | 'skipped' | 'unsupported' | 'failed'`
(`revoked: boolean` is unchanged). `revoked: false` meant three things at once:
the caller asked for a local-only disconnect, the adapter has no revocation
endpoint and never will (Microsoft Graph), or we asked and the provider did not
answer. Only the last is worth retrying, and only the middle one warrants
sending the user to a consent portal — which is what the guide's own example
did, unconditionally. RFC 0002 §D.3.1 identified this ambiguity and left it
documented on the grounds that a third connection *status* would carry one
vendor's absence into every adapter; that reasoning is sound and does not apply
to a hook payload the engine fills in from facts it already has. No adapter
changes.

**Contract documentation, where a reader actually hits it** rather than in an
RFC appendix: `DriveChecksum` now states that a checksum is comparable within
one provider and on Microsoft only within one account type, and absent entirely
for Google-native documents; `DriveProvider.upload` and `DriveUploadInput` now
carry the per-adapter ceilings (4 MB / 5 MB / 150 MB) and explain that supplying
`size` is what moves the refusal from mid-stream to up front; and
`DriveProvider.verifyNotification` now states that "verified" is a real HMAC
over the raw body on Dropbox and a secret we chose on Google and Microsoft,
which sign nothing — and that what makes the weaker two acceptable is the blast
radius, not the secret. The guide and README carry the same three, plus a
correction: they claimed a truncated run "resumes exactly where it stopped",
which was never true of a plain listing and is now true of a backfill.

Tests: `tests/audit-phase2.test.ts` — the leak (4), backfill resumption (4),
revocation outcomes (4), and the cross-host credential stripping that phase 2c
shipped without any coverage at all (2). `FakeDriveProvider` gains
`failNextListWith` to drive a failure the engine did not create.
