---
'@basaltkit/auth': minor
'@basaltkit/auth-sqlite': minor
'@basaltkit/auth-prisma': minor
---

Create already-verified accounts from trusted flows (BK-045).

- `auth.register(email, password, { emailVerified: true })` creates the account verified; the flag is persisted at create time through `UserSource.create({ email, passwordHash, emailVerified? })` (new exported `NewUser` type), so `auth:registered` reports the final state.
- Fix: `socialLogin` emitted `auth:registered` before marking a provider-verified account verified, so mail hooks saw `emailVerified: false`. The account is now created verified and the hook fires afterwards.
- Fix: `socialLogin` silently left a provider-verified account unverified when the `UserSource` had no `update()`. A source that drops the flag is now patched through `update()`, and without one the call throws `UserUpdateUnsupportedError`.
- `SqliteUserSource` and `PrismaUserSource` persist `emailVerified` on create (no schema change).
- The public `POST /auth/register` never creates a verified account.
