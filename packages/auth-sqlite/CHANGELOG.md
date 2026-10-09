# @basaltkit/auth-sqlite

## 2.1.0

### Minor Changes

- cdc20f6: Create already-verified accounts from trusted flows (BK-045).
  
  - `auth.register(email, password, { emailVerified: true })` creates the account verified; the flag is persisted at create time through `UserSource.create({ email, passwordHash, emailVerified? })` (new exported `NewUser` type), so `auth:registered` reports the final state.
  - Fix: `socialLogin` emitted `auth:registered` before marking a provider-verified account verified, so mail hooks saw `emailVerified: false`. The account is now created verified and the hook fires afterwards.
  - `socialLogin` passes the provider's verification to `create()`, and a `UserSource` that drops the flag is patched through `update()`. A custom source that can do neither (no `update()`, a `create()` that ignores `emailVerified`) cannot record verification at all: the account is created unverified, linked to the provider identity and logged in, exactly as before — never a `500` after the row exists, which would leave an unlinked account every later login refuses (`AUTH_SOCIAL_LINK_REFUSED`). `auth:registered` and the result report `emailVerified: false` truthfully; to get verified social accounts, persist `emailVerified` in `create()` or implement `update()`. A first login that fails after the row exists (e.g. `update()` throws) is recovered by the retry, which adopts the passwordless account.
  - `register(…, { emailVerified: true })` requires a `UserSource` with `update()` (the same requirement as email verification). Without it the call throws `UserUpdateUnsupportedError` (`AUTH_UPDATE_UNSUPPORTED`, 500) **before anything is written**: whether `create()` persists the flag can only be learnt by writing the row, and a row that could not be fixed afterwards would leave an unverified account that a retry reports as `EmailTakenError`. The option is new in this release, so no existing call is affected.
  - `SqliteUserSource` and `PrismaUserSource` persist `emailVerified` on create (no schema change).
  - The public `POST /auth/register` never creates a verified account.
- 19fb4c6: BK-076: session hardening.
  
  - `@basaltkit/auth`: `sessionIdleTtl` adds an idle timeout to server-side sessions — a session unused for longer is refused and deleted, on top of the absolute `sessionTtl`. Activity is recorded through the new optional `SessionStore.touch(id, at)`, throttled to once per `min(60s, sessionIdleTtl / 4)`; `SessionRecord` gains optional `lastSeenAt`. `sessionIdleTtl` is a new opt-in option and is validated fail-closed: a value that is not a positive duration, or a session store without `touch`, makes `authPlugin` fail at boot (`SessionIdleConfigError`, `AUTH_SESSION_IDLE_CONFIG_INVALID`) rather than configuring an idle timeout that would silently never expire a session. Configurations without `sessionIdleTtl` are unaffected.
  - `@basaltkit/auth`: a session cookie named `__Host-…` or `__Secure-…` now implies `Secure` (and `Path=/` for `__Host-`) when `secure` / `path` are unset, in every environment — before, outside production such a cookie was emitted without `Secure` and browsers silently dropped it. **Test-client caveat:** cookie jars that honour `Secure` (supertest/superagent, tough-cookie) do not send a `Secure` cookie back over plain `http`, so a suite that relied on the old non-`Secure` emission now gets 401s; outside production this case logs a one-time boot warning. Use an unprefixed name outside production (e.g. `name: isProd ? '__Host-sid' : 'sid'`), or set `secure` explicitly (`secure: true` silences the warning).
  - **Upgrade — warns at boot (refused in the next major).** A prefixed `sessionCookie.name` with an explicit `secure: false` — including the common `secure: process.env.NODE_ENV === 'production'`, which is `false` in dev and test — or a `__Host-` cookie with a `path` other than `/`, still boots and the cookie is emitted exactly as configured, as before; it logs one `[basalt] sessionCookie …` warning per configuration, because browsers drop such a cookie. The next major refuses it with `SessionCookieConfigError` (`AUTH_SESSION_COOKIE_INVALID`), which is already exported. Fix now: drop `secure` (the prefix implies it) and `path`, or use an unprefixed name outside production.
  - `@basaltkit/auth`: cookie prefixes are matched case-insensitively, as browsers do (`__host-sid` is a `__Host-` cookie and implies `Secure`). The boot warnings are independent and each is logged once per `sessionCookie` object — a `__Host-` cookie with a sub-path and `secure` unset outside production now gets both the path warning and the implied-`Secure` one (before, only the path warning). An unprefixed cookie with `sameSite: 'None'` and no `Secure` now warns too (emitted unchanged; browsers drop it).
  - `@basaltkit/auth-sqlite`: `SqliteSessionStore` records `last_seen_at` and implements `touch`; `migrate()` adds the column to existing databases.
  - `@basaltkit/auth-prisma`: `trackSessionActivity: true` makes `PrismaSessionStore` write `AuthSession.lastSeenAt` and implement `touch`. Off by default, so an unmigrated database keeps working; the column is in the reference schemas — migrate before enabling.

## 2.0.0

### Major Changes

- b69ea05: Framework audit — the open auth items (FA-058 account linking, FA-059 clone detection, FA-070/D9 legacy emails, FA-H16/BK-027 secret box).
  
  - **OAuth/OIDC logins are bound to the provider subject (FA-058).** A login used to be matched by email alone and the provider's `sub` was ignored. `Auth` now keeps account links (provider + subject → user) in a new `AccountLinkStore` (`authPlugin({ accountLinks })`; `MemoryAccountLinkStore` by default, `PrismaAccountLinkStore` / `SqliteAccountLinkStore` for production, both in `prismaAuthStores()` / `sqliteAuthStores()` as `accountLinks`). `socialLogin(email, { identity: { provider, subject } })` — which `OAuth.callback` now always passes — looks the link up first: a linked provider account reaches its account even after the email changes at the IdP. Without a link the first login matches by email under the existing rules (an existing account only through a provider-verified email, after `allowedEmailDomains`) and records the link (`auth:account_linked`). A **different** subject of the same provider asserting the email of an account already linked to that provider is refused with the new `AccountLinkConflictError` (`409 AUTH_ACCOUNT_LINK_CONFLICT`) unless `oauthPlugin({ subjectConflict: 'link' })`. Adopting a never-verified account also drops the account links its first registrant made.
  - **WebAuthn clone detection is atomic (FA-059).** `PasskeyStore` gains `compareAndSetCounter(id, expected, next, lastUsedAt): Promise<boolean>`, and `finishAuthentication` writes the counter only through it: two concurrent assertions presenting the same counter (a cloned authenticator racing the genuine one) can no longer both pass — the loser gets `PASSKEY_CLONED`. `MemoryPasskeyStore`, the new `PrismaPasskeyStore` and `SqlitePasskeyStore` implement it as a conditional update. `updateCounter` is deprecated and optional; a store without `compareAndSetCounter` is refused when `WebAuthnService` is built (`PasskeyStoreOutdatedError`, `PASSKEY_STORE_OUTDATED`).
  - **Legacy mixed-case emails (FA-070/D9).** `PrismaUserSource.findByEmail` matches case-insensitively on PostgreSQL and **refuses ambiguity**: two rows differing only in letter case throw the new `AccountEmailAmbiguousError` (`AUTH_EMAIL_AMBIGUOUS`, not exposed) instead of the canonical row winning; `create` refuses a case variant of an existing row (`EmailTakenError`, also for a `P2002` from a concurrent insert). `SqliteUserSource.findByEmail` refuses the same ambiguity instead of returning the oldest row. Both packages export `normalizeAuthUserEmails()` — lowercases lone mixed-case rows and reports the twins (`{ normalized, conflicts }`, `dryRun`); the SQLite one then builds the `NOCASE` unique index. On MySQL the insensitive probe is attempted once, then the exact (collation-insensitive) lookup is used.
  - **TOTP secret box (FA-H16 / BK-027).** Secrets are sealed as `bka2.<keyId>.<iv>.<tag>.<ct>`: AES-256-GCM with HKDF-SHA256 keys (was a bare SHA-256 of the key), a key id, and the user id bound as associated data (a ciphertext copied into another user's row does not open). `authPlugin({ mfaEncryption: { keys: [{ id, key }, …] } })` is a key ring — the first key seals, the others stay readable — and `auth.reencryptMfaSecret(userId)` re-seals a row under the active key. A stored value that is not an envelope is **refused** (`SecretUnreadableError`, `AUTH_SECRET_UNREADABLE`): a database write can no longer downgrade an encrypted TOTP secret to a plaintext one the writer knows. `SecretBox` is exported.
  - **auth-prisma schema:** new models `AuthAccountLink` (`auth_account_links`) and `AuthPasskey` (`auth_passkeys`), MySQL-safe (hashed primary keys, `BigInt` counter, JSON-text transports). The delegates are optional in `PrismaAuthClient`; a client without them throws `AuthModelMissingError` (`AUTH_PRISMA_MODEL_MISSING`) at first use of those stores. `authUser.findFirst` is no longer used. auth-sqlite's `migrate()` creates `auth_account_links` and `auth_passkeys` on existing databases.
  - **create-basalt:** the `--prisma` scaffold's schema includes the two new auth models.
  
  **Why major, and how to migrate:**
  
  - **MFA encryption.** Keys must be at least 32 bytes (`AUTH_SECRET_BOX_KEY_INVALID` otherwise), and rows written before (`v1:` envelopes, or plaintext) are refused. Upgrade with a temporary opt-in, re-encrypt, then remove it:
    ```ts
    authPlugin({ …, mfaEncryption: { keys: [{ id: '2026-09', key: NEW_KEY_32_BYTES }], legacy: { v1Keys: [OLD_MFA_ENCRYPTION_KEY], plaintext: true } } })
    for (const userId of usersWithMfa) await auth.reencryptMfaSecret(userId)
    // then drop `legacy`
    ```
    Setting both `mfaEncryption` and `mfaEncryptionKey` throws. Apps without MFA encryption are unaffected.
  - **Custom `PasskeyStore`s** must implement `compareAndSetCounter` (one `UPDATE … WHERE id = ? AND counter = ?` returning whether a row changed).
  - **OAuth:** configure a durable `accountLinks` store (`s.accountLinks`). Existing users are linked on their next login by verified email, as before; from then on a second IdP account claiming the same email gets `409 AUTH_ACCOUNT_LINK_CONFLICT`. Custom `Auth.socialLogin` callers should pass `identity: { provider, subject }`.
  - **auth-prisma:** add the `AuthAccountLink` and `AuthPasskey` models (copy from `@basaltkit/auth-prisma/schema.prisma` or `basalt prisma:sync`), then `prisma migrate dev --name auth_account_links_passkeys` — in every tenant schema with schema-per-tenant; on MySQL copy them from `@basaltkit/auth-prisma/schema.mysql.prisma` instead (`subject`, `credentialId` and `publicKey` are `@db.Text` there). Run `normalizeAuthUserEmails(prisma, { dryRun: true })`, then without `dryRun`, and merge any reported `conflicts` — until then those emails throw `AUTH_EMAIL_AMBIGUOUS`. Hand-written `PrismaAuthClient` stubs: `authUser.findMany` must honour `where.email` (`equals`/`mode`), `orderBy` and `take`.
  - **auth-sqlite:** run `normalizeAuthUserEmails(db)` on a legacy database with case-variant duplicates and merge the reported `conflicts`.

### Patch Changes

- e53db52: Framework audit, pass 2 — persistent stores (FA-068, FA-069, FA-070).
  
  Major for tenancy-prisma, webhooks-prisma, webhooks-sqlite and auth-prisma: a generated PrismaClient still fits the new client interfaces (`$transaction`, `create`/`updateMany`), but hand-written clients and test fakes must add those methods, and cross-scope writes that used to succeed now throw.
  
  - **tenancy-prisma — `save()` / `create()` are atomic (FA-068).** The tenant
    row, the domain check and the domain set (`deleteMany` + `createMany`) now
    run in one interactive `$transaction`. Before, any failure after the delete —
    a domain listed twice, a domain another tenant claimed between the
    pre-flight and the insert, a lost connection — left the tenant rewritten with
    its existing domains gone. Duplicate domains in the array are stored once.
    `PrismaTenancyClient` now includes `$transaction` (a generated
    `PrismaClient` has it; a hand-written client must add it).
  - **webhooks-prisma — writes are keyed by `(id, tenantId)` (FA-069).**
    `add()` was an upsert by `id` alone: on MySQL's case-insensitive collation
    tenant A re-registering `ABC` rewrote tenant B's `abc` endpoint (url,
    secret, tenant). It is now an `updateMany` scoped to the endpoint's own
    tenant (or global scope), falling back to `create`; an id held by another
    scope throws the new `WebhookEndpointIdInUseError` (409). Re-adding an id in
    its own scope still replaces it. `PrismaWebhooksClient` now needs
    `create`/`updateMany` instead of `upsert` (a generated `PrismaClient` has
    them).
  - **webhooks-sqlite — no `INSERT OR REPLACE` across scopes (FA-070/D8).** The
    manager's check-before-write cannot stop two tenants registering the same id
    at once; the store now refuses an id held by another scope with
    `WebhookEndpointIdInUseError` (409) instead of overwriting that endpoint.
  - **auth-prisma — `touch()`/`revoke()` of a missing API key are no-ops
    (FA-070/I4)**, as in the other stores, instead of a Prisma `P2025` thrown
    out of `verify()`. The client surface uses `authApiKey.updateMany` (no longer
    `update`).
  - **auth-sqlite — email uniqueness without the NOCASE index (FA-070/D9).** A
    legacy database holding case-variant duplicates cannot build the
    case-insensitive unique index, and `migrate()` skipped it silently; `create`
    now refuses an email that exists in any letter case inside the `INSERT`
    itself, throwing `EmailTakenError` (409) — also for the race between two
    concurrent sign-ups.
  - **files-prisma — `prismaFilesStore()` fails fast** when the client has no
    `file` model, like every other `*-prisma` factory (FA-070/I4).
  - **permissions-sqlite — multi-permission grants are all-or-nothing**
    (FA-070/I5): `grantToRole` / `grantToUser` run in one savepoint.
- Updated dependencies [e54b7b1]
- Updated dependencies [b69ea05]
- Updated dependencies [e53db52]
- Updated dependencies [e54b7b1]
  - @basaltkit/auth@4.0.0

## 1.7.0

### Minor Changes

- d232f5f: Notify everyone with a role without reaching into the auth tables (BK-022).
  
  `teams.members(tenantId)` returns `{ tenantId, userId, role }` and
  `@basaltkit/auth` only exposed `users.findById(id)`, so "email every admin of
  this tenant" forced an app into either N lookups or reading the auth schema
  directly. Both packages now cover it, from opposite ends, without either one
  importing the other.
  
  **`@basaltkit/auth`** — `UserSource.findByIds(ids)`, an **optional** bulk
  counterpart of `findById`. It resolves `PublicUser[]` (never `AuthUser`: a
  directory lookup carries no password hash, MFA secret or any other credential
  field), one entry per *found* id in the order of `ids`, duplicates collapsed and
  an empty list short-circuited. Implemented in `MemoryUserSource`, and in both
  drivers as a single `WHERE id IN (…)` per chunk — `PrismaUserSource` `select`s
  only `id`/`email`/`emailVerified` so the hash is never even read, and both chunk
  at 500 ids (`idChunkSize`) so a large tenant cannot exceed the driver's
  bind-parameter limit. Stores written before this keep compiling.
  
  **`@basaltkit/teams`** — `teamsPlugin({ users })` takes a read-only user
  directory (`MemberUserSource`; an `@basaltkit/auth` `UserSource` satisfies it
  structurally) and adds:
  
  - `membersWithUsers(tenantId)` — the tenant's memberships with each member's
    `{ id, email, emailVerified }` attached. It is the single place the lookup
    happens: `findByIds` when the source has it, one `findById` per member when it
    doesn't, so apps get the fast path automatically.
  - `roleRecipients(tenantId, role, { exact? })` — a filter over it (no extra
    query) honouring `roleRank`: a ranked role includes everyone at or above it,
    an unranked role matches exactly (every unranked role ranks 0, so ranking them
    would notify all of them).
  - `teamRoutes({ memberContacts: true })` — opt-in `user` on each entry of
    `GET /team/members`; off by default.
  
  Tenant safety throughout: the ids come from that tenant's membership records and
  never from a request, a user the directory returns that was not asked for is
  discarded, whatever the directory hands back is projected down to the three safe
  fields, and a membership whose account no longer exists is skipped rather than
  breaking the list (`user` is required on `TeamMemberWithUser`). Without a `users`
  directory the new methods throw `TeamUserSourceMissingError`
  (`TEAM_USER_SOURCE_MISSING`, 500).
  
  Note for `@basaltkit/auth-prisma`: the `PrismaAuthClient.authUser` delegate now
  also declares `findMany`. A real `PrismaClient` already has it; only a
  hand-written stub of that interface needs the method added.

## 1.6.0

### Minor Changes

- fb85c40: Security hardening (secure-by-default changes):
  
  - **API keys are bound to their tenant.** A key issued inside a tenant is refused (`403 AUTH_APIKEY_TENANT_MISMATCH`) on any request that resolves a different tenant, or none. Keys issued without a tenant are refused on tenant-scoped requests unless `apiKeysPlugin({ allowTenantlessKeys: true })`.
  - **API-key scopes are an upper bound.** A key without `*` can no longer act as its owner on `meta.auth`/`can`/`teamRole`/`audience` routes that declare no `meta.scopes` (opt-out: `allowNarrowKeysOnUnscopedRoutes: true`). New `meta.apiKey: false` makes a route session-only; `apiKeyRoutes()` and `mfaRoutes()` declare it, so a key can no longer mint, list or revoke keys, or change MFA.
  - **Social/SSO login** links to an existing account only when the provider verified the email (`SocialLinkRefusedError`). It honours the account's MFA (`MfaRequiredError`; explicit `mfa: 'skip'` opt-out on `socialLogin` / `oauthPlugin`). When it adopts an account whose email was never verified, it revokes that account's password, sessions, refresh tokens and MFA (`auth:social_account_adopted`).
  - **OAuth flows are browser-bound and single-use.** `oauthRoutes` sets an HttpOnly binding cookie, the signed `state` carries its hash, and the code exchange uses PKCE (S256) plus an OIDC nonce. `OAuth.authorizeUrl` now takes a `binding` (use the new `OAuth.authorize()`), and `OAuth.callback` requires it.
  - **Cookie-session CSRF check** in `authPlugin`: a cross-site/same-site, cookie-only, state-changing request is not authenticated (`403 AUTH_CSRF_REJECTED`). Configure it with `csrf: { trustedOrigins }`, or turn it off with `csrf: false`.
  - `enrollMfa` refuses an account whose MFA is already on (`MfaAlreadyEnabledError`), so re-enrolling can no longer switch MFA off without a code.
  - TOTP anti-replay and recovery-code consumption are atomic. `MfaStore` gains optional `consumeTotpStep` / `consumeRecoveryCode`, which the memory, SQLite and Prisma stores implement.
  - Login throttling reserves the attempt before verifying it, so parallel bursts cannot exceed the budget. `LoginThrottle` stores hashed keys and is bounded (`maxEntries`).
  - Auth route inputs are size-capped (email 254, password 1024, tokens 512). The public auth routes declare a default `meta.rateLimit` (`authRoutes({ rateLimit })` to tune or turn off). Reset and verification emails are throttled per account (`emailRequestThrottle`).
  - Emails are case-insensitive identities: `Auth` canonicalises them, and the memory, SQLite (NOCASE lookup and unique index) and Prisma (canonical storage and case-insensitive fallback lookup) stores match them case-insensitively.
  - `revokeAllTokens` also revokes refresh tokens and sessions. `refresh()` refuses tokens of deleted users, and a rotated token can no longer outlive a concurrent family revocation.
  - New security events: `auth:mfa_failed`, `auth:locked_out`, `auth:refresh_reused` and `auth:apikey_rejected`.

### Patch Changes

- Updated dependencies [fb85c40]
  - @basaltkit/auth@3.0.0

## 1.5.0

### Minor Changes

- ad40683: Add optional API key expiration dates across the auth stores, routes, and management UI.

## 1.4.1

### Patch Changes

- Updated dependencies [36ab1a1]
- Updated dependencies [36ab1a1]
- Updated dependencies [d5ca076]
  - @basaltkit/auth@2.0.0

## 1.4.0

### Minor Changes

- 104cfb3: Refresh-token reuse detection is now atomic — a compare-and-swap, not a read-then-write.
  
  **Advisory — this changes a store contract.** `Auth.refresh()` reads the record, checks `usedAt`, then calls `markUsed()`. The database stores implemented `markUsed` as an unconditional `UPDATE … WHERE token = ?`, so the check and the write were not one operation: two concurrent refreshes of the same token — the legitimate client and a thief racing it — could both read `usedAt = null` and both succeed. Rotation-reuse detection, the whole point of the family, never fired. Verified live: `Promise.allSettled([auth.refresh(t), auth.refresh(t)])` returned **two** valid token pairs.
  
  `AuthTokenStore.markUsed` and `RefreshTokenStore.markUsed` now return `Promise<boolean | void>`: `true` when *this* call consumed the token, `false` when someone else already had. The shipped stores do a conditional update (`WHERE token = ? AND used_at IS NULL`, `where: { token, usedAt: null }`) and report the row count. `Auth.refresh()` treats `false` as reuse — it revokes the family and throws `AUTH_REFRESH_REUSED`; `consumeToken()` (email verification, password reset) treats it as a spent token and throws `AUTH_TOKEN_INVALID`. The same race now resolves to exactly one winner and one `RefreshReusedError`.
  
  Returning `void` keeps the pre-CAS behaviour, so a **third-party store written against the old contract keeps compiling and working** — without the race protection. If you maintain one, make `markUsed` conditional and return whether it consumed the token.

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.

## 1.3.0

### Minor Changes

- Persist the TOTP `lastUsedStep` (anti-replay) and add the `auth_token_versions` table + `SqliteTokenVersionStore` for access-token revocation.

## 1.2.0

### Minor Changes

- Security: **`SqliteSessionStore` hashes session ids at rest.** It now mints a raw id for the client but stores `sha256(id)` in `auth_sessions`, hashing on the way in for `find`/`delete`, so a dump of the table can't be replayed as a live session (see `@basaltkit/auth` 1.2.0). No schema change; existing sessions are invalidated once on upgrade.

## 1.1.0

### Minor Changes

- Add `SqliteSessionStore.deleteAllForUser(userId)` so a password reset revokes every one of the user's active sessions (see `@basaltkit/auth` 1.1.0). Deletes all `auth_sessions` rows for the user in one statement.

## 1.0.5

### Patch Changes

- Lockstep 1.0.5 release. No code changes in this package; it moves with the
  ecosystem-wide durable/Redis backend expansion (tenancy, events outbox,
  webhooks, rate-limiting, idempotency). Internal `@basaltkit/*` dependencies now
  use caret ranges (`workspace:^`).

## 1.0.2

### Patch Changes

- Add `PRAGMA busy_timeout = 5000` so a write waits for a competing writer's
  lock (up to 5s) instead of throwing `database is locked` immediately. Prevents
  spurious 500s under dev auto-reload (`tsx watch`) or concurrent writers.

## 1.0.1

### Patch Changes

- Fix a runtime crash when consumed from the published package: the bundler
  stripped the `node:` prefix from the `node:sqlite` import, emitting a broken
  `from "sqlite"` that failed with `ERR_MODULE_NOT_FOUND: Cannot find package 'sqlite'`.
  The builtin is now loaded through an opaque specifier the bundler leaves intact.

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@basaltkit/*` ecosystem.

## 0.25.0

### Minor Changes

- Initial release. Durable, SQLite-backed implementations of every
  `@basaltkit/auth` store — users, sessions, refresh tokens, one-time tokens, API
  keys and MFA — built on Node's built-in `node:sqlite`, with zero external
  dependencies. `sqliteAuthStores(location)` returns every store named to drop
  straight into `authPlugin`/`apiKeysPlugin`, so auth state survives process
  restarts. Each store is also exported individually and accepts a shared
  `DatabaseSync`. The first reference "real backend" on the road to 1.0.
