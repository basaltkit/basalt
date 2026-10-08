---
'@basaltkit/auth': minor
'@basaltkit/auth-sqlite': minor
'@basaltkit/auth-prisma': minor
---

Create already-verified accounts from trusted flows (BK-045).

- `auth.register(email, password, { emailVerified: true })` creates the account verified; the flag is persisted at create time through `UserSource.create({ email, passwordHash, emailVerified? })` (new exported `NewUser` type), so `auth:registered` reports the final state.
- Fix: `socialLogin` emitted `auth:registered` before marking a provider-verified account verified, so mail hooks saw `emailVerified: false`. The account is now created verified and the hook fires afterwards.
- `socialLogin` passes the provider's verification to `create()`, and a `UserSource` that drops the flag is patched through `update()`. A custom source that can do neither (no `update()`, a `create()` that ignores `emailVerified`) cannot record verification at all: the account is created unverified, linked to the provider identity and logged in, exactly as before — never a `500` after the row exists, which would leave an unlinked account every later login refuses (`AUTH_SOCIAL_LINK_REFUSED`). `auth:registered` and the result report `emailVerified: false` truthfully; to get verified social accounts, persist `emailVerified` in `create()` or implement `update()`. A first login that fails after the row exists (e.g. `update()` throws) is recovered by the retry, which adopts the passwordless account.
- `register(…, { emailVerified: true })` on a source that can do neither throws `UserUpdateUnsupportedError` (`AUTH_UPDATE_UNSUPPORTED`, 500) after `create()`: the account exists, unverified, and a retry gets `EmailTakenError`. It is a trusted server-side call; fix the source rather than retry.
- `SqliteUserSource` and `PrismaUserSource` persist `emailVerified` on create (no schema change).
- The public `POST /auth/register` never creates a verified account.
