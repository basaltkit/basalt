import { ctx, BasaltError, type Container } from '@basaltkit/core'
import { route, type BasaltRoute } from '@basaltkit/http'
import { z } from 'zod'
import { AUTH } from './plugin.js'
import { API_KEYS } from './apikeys-plugin.js'

/**
 * How strong a password has to be.
 *
 * The rule was `min(8)`, fixed, with no way to change it — the 2012 minimum, in
 * routes an application either uses as they are or replaces wholesale. One that
 * needed more reached into the route's Zod object and swapped the field,
 * depending on the internal shape of a body it does not own.
 *
 * A whole schema and not just a number, because the interesting rules are not
 * lengths: "at least one symbol", "not the email address", "not in a breach
 * list". An option taking only a number would send those applications straight
 * back to patching.
 */
export interface PasswordPolicy {
  minLength?: number
}

export interface AuthRoutesOptions {
  /**
   * A minimum length, or the schema itself. Default: `min(8)`. Whatever the
   * policy, passwords are capped at {@link MAX_PASSWORD_LENGTH} characters
   * before it runs, so an oversized body never reaches the password hasher.
   */
  password?: PasswordPolicy | z.ZodType<string>
  /**
   * Per-route rate limit (`meta.rateLimit`, enforced per client ip by
   * `securityPlugin` when its rate limiter is on) for the unauthenticated
   * routes that hash, mail or guess: register, login, verification requests
   * and password forgot/reset.
   * Default {@link DEFAULT_AUTH_RATE_LIMIT}; pass `false` to omit it.
   */
  rateLimit?: { limit: number; windowMs: number } | false
}

/** RFC 5321 caps a forward path at 254 characters. */
export const MAX_EMAIL_LENGTH = 254
/** Far above any passphrase; bounds the work an unauthenticated body can cause. */
export const MAX_PASSWORD_LENGTH = 1024
/** Default `meta.rateLimit` on the public auth routes: 10 requests per minute per ip and route. */
export const DEFAULT_AUTH_RATE_LIMIT = { limit: 10, windowMs: 60_000 } as const

const email = () => z.string().trim().max(MAX_EMAIL_LENGTH).email()
const token = () => z.string().max(512)
const DEFAULT_PASSWORD = z.string().min(8).max(MAX_PASSWORD_LENGTH)

const passwordSchema = (policy: AuthRoutesOptions['password']): z.ZodType<string> => {
  if (!policy) return DEFAULT_PASSWORD
  if (typeof (policy as z.ZodType).safeParse === 'function') {
    return z.string().max(MAX_PASSWORD_LENGTH).pipe(policy as unknown as z.ZodType<string, string>) as unknown as z.ZodType<string>
  }
  const { minLength } = policy as PasswordPolicy
  return minLength === undefined ? DEFAULT_PASSWORD : z.string().min(minLength).max(MAX_PASSWORD_LENGTH)
}

const auth = () => (ctx().container as Container).get(AUTH)
const apiKeys = () => (ctx().container as Container).get(API_KEYS)

/**
 * Ready-made auth routes — register them in fastifyPlugin({ routes }):
 * register · login · refresh · logout · me, plus email verification
 * (`/auth/verify/request`, `/auth/verify`) and password reset
 * (`/auth/password/forgot`, `/auth/password/reset`).
 * Every one is a plain BasaltRoute: replace or omit any of them freely.
 */
export function authRoutes(options: AuthRoutesOptions = {}): BasaltRoute[] {
  const password = passwordSchema(options.password)
  const credentials = z.object({ email: email(), password })
  const limit = options.rateLimit === false ? {} : { rateLimit: options.rateLimit ?? { ...DEFAULT_AUTH_RATE_LIMIT } }

  return [
    route({
      method: 'POST',
      url: '/auth/register',
      meta: { ...limit },
      body: credentials,
      // Enumeration-safe: the same 202 whether the email is new or already taken
      // (a collision is signalled out-of-band via auth:register_existing_email).
      async handler({ body, reply }) {
        await auth().registerSafely(body.email, body.password)
        return reply.code(202).send({ ok: true })
      },
    }),

    route({
      method: 'POST',
      url: '/auth/login',
      meta: { ...limit },
      body: credentials.extend({ mfaCode: z.string().max(64).optional() }),
      async handler({ body, request, reply }) {
        const { user, tokens } = await auth().login(
          body.email,
          body.password,
          body.mfaCode,
          request.ip ? { ip: request.ip } : {},
        )
        const session = await auth().createSession(user.id)
        const sessionCookie = auth().sessionCookieHeader(session.id)
        if (sessionCookie) reply.header('set-cookie', sessionCookie)
        return { user, ...tokens }
      },
    }),

    route({
      method: 'POST',
      url: '/auth/refresh',
      body: z.object({ refreshToken: token() }),
      async handler({ body }) {
        return auth().refresh(body.refreshToken)
      },
    }),

    route({
      method: 'POST',
      url: '/auth/logout',
      body: z.object({ refreshToken: token() }),
      async handler({ body, request, reply }) {
        await auth().revoke(body.refreshToken)
        const sessionId = auth().sessionIdFromCookie(request.headers.cookie as string | undefined)
        if (sessionId) await auth().logout(sessionId)
        const expiredCookie = auth().expiredSessionCookieHeader()
        if (expiredCookie) reply.header('set-cookie', expiredCookie)
        return reply.code(204).send()
      },
    }),

    route({
      method: 'GET',
      url: '/auth/me',
      meta: { auth: true },
      async handler() {
        return ctx().user
      },
    }),

    // --- email verification ------------------------------------------------
    route({
      method: 'POST',
      url: '/auth/verify/request',
      meta: { ...limit },
      body: z.object({ email: email() }),
      async handler({ body }) {
        // The app emails the token (via the auth:verify_requested hook). Always
        // 200, so the response never reveals whether the email has an account.
        await auth().requestEmailVerification(body.email)
        return { ok: true }
      },
    }),

    route({
      method: 'POST',
      url: '/auth/verify',
      body: z.object({ token: token() }),
      async handler({ body }) {
        return { user: await auth().verifyEmail(body.token) }
      },
    }),

    // --- password reset ----------------------------------------------------
    route({
      method: 'POST',
      url: '/auth/password/forgot',
      meta: { ...limit },
      body: z.object({ email: email() }),
      async handler({ body }) {
        await auth().requestPasswordReset(body.email)
        return { ok: true }
      },
    }),

    route({
      method: 'POST',
      url: '/auth/password/reset',
      // The same policy as register. Covering register and leaving reset behind
      // would let anyone walk a strong password back down to eight characters
      // through "forgot password" — a loophole worse than having no option.
      meta: { ...limit },
      body: z.object({ token: token(), password }),
      async handler({ body }) {
        await auth().resetPassword(body.token, body.password)
        return { ok: true }
      },
    }),
  ]
}

class ApiKeyForbiddenError extends BasaltError {
  readonly status = 404
  constructor() {
    super('AUTH_APIKEY_NOT_FOUND', 'API key not found.')
  }
}

/**
 * CRUD routes for API keys, all requiring a logged-in user (`meta.auth`). Keys
 * are scoped to the caller's tenant (`ctx().tenant`) and user; a caller only
 * ever sees or revokes keys within that scope. Register alongside
 * {@link authRoutes} and pair with `apiKeysPlugin`.
 */
export function apiKeyRoutes(): BasaltRoute[] {
  // `tenant` is set by @basaltkit/tenancy when present; read it without a hard
  // dependency on that package's type augmentation.
  const scope = (): { tenantId?: string; userId?: string } => {
    const c = ctx() as { tenant?: { id: string }; user?: { id: string } }
    return {
      ...(c.tenant ? { tenantId: c.tenant.id } : {}),
      ...(c.user ? { userId: c.user.id } : {}),
    }
  }

  return [
    route({
      method: 'POST',
      url: '/apikeys',
      // Session-only: a key must never mint, list or revoke keys (a narrow or
      // expiring key could otherwise mint a permanent '*' key).
      meta: { auth: true, apiKey: false },
      body: z.object({
        name: z.string().min(1).max(100),
        scopes: z.array(z.string().min(1)).optional(),
        expiresAt: z.number().int().positive().optional(),
      }),
      async handler({ body, reply }) {
        const { record, key } = await apiKeys().issue({ ...body, ...scope() })
        // `key` is returned exactly once — it is never retrievable again.
        return reply.code(201).send({ ...record, key })
      },
    }),

    route({
      method: 'GET',
      url: '/apikeys',
      // Session-only: a key must never mint, list or revoke keys (a narrow or
      // expiring key could otherwise mint a permanent '*' key).
      meta: { auth: true, apiKey: false },
      async handler() {
        return apiKeys().list(scope())
      },
    }),

    route({
      method: 'DELETE',
      url: '/apikeys/:id',
      meta: { auth: true, apiKey: false },
      params: z.object({ id: z.string() }),
      async handler({ params, reply }) {
        const record = await apiKeys().get(params.id)
        const { tenantId, userId } = scope()
        // Only expose/act on keys within the caller's scope; otherwise 404.
        if (!record || record.tenantId !== tenantId || record.userId !== userId) {
          throw new ApiKeyForbiddenError()
        }
        await apiKeys().revoke(params.id)
        return reply.code(204).send()
      },
    }),
  ]
}

class MfaAuthRequiredError extends BasaltError {
  readonly status = 401
  constructor() {
    super('AUTH_REQUIRED', 'Authentication required.')
  }
}
const currentUserId = (): string => {
  const id = ctx().user?.id
  if (!id) throw new MfaAuthRequiredError()
  return id
}

/**
 * MFA (TOTP) self-service routes, all requiring a logged-in user: enroll,
 * activate (returns one-time recovery codes), status, and disable. Register
 * alongside {@link authRoutes} and enable MFA at login via the optional
 * `mfaCode` field on `POST /auth/login`.
 */
export function mfaRoutes(): BasaltRoute[] {
  return [
    route({
      method: 'POST',
      url: '/auth/mfa/enroll',
      meta: { auth: true, apiKey: false },
      async handler() {
        return auth().enrollMfa(currentUserId())
      },
    }),

    route({
      method: 'POST',
      url: '/auth/mfa/activate',
      meta: { auth: true, apiKey: false },
      body: z.object({ code: z.string().min(6).max(64) }),
      async handler({ body }) {
        return auth().activateMfa(currentUserId(), body.code)
      },
    }),

    route({
      method: 'GET',
      url: '/auth/mfa/status',
      meta: { auth: true, apiKey: false },
      async handler() {
        return auth().mfaStatus(currentUserId())
      },
    }),

    route({
      method: 'POST',
      url: '/auth/mfa/disable',
      meta: { auth: true, apiKey: false },
      body: z.object({ code: z.string().min(6).max(64) }),
      async handler({ body, reply }) {
        await auth().disableMfa(currentUserId(), body.code)
        return reply.code(204).send()
      },
    }),
  ]
}
