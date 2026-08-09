import { ctx, BasaltError, type Container } from '@basaltkit/core'
import { route, type BasaltRoute } from '@basaltkit/fastify'
import { z } from 'zod'
import { AUTH } from './plugin.js'
import { API_KEYS } from './apikeys-plugin.js'

const credentials = z.object({ email: z.string().email(), password: z.string().min(8) })

const auth = () => (ctx().container as Container).get(AUTH)
const apiKeys = () => (ctx().container as Container).get(API_KEYS)

/**
 * Ready-made auth routes — register them in fastifyPlugin({ routes }):
 * register · login · refresh · logout · me, plus email verification
 * (`/auth/verify/request`, `/auth/verify`) and password reset
 * (`/auth/password/forgot`, `/auth/password/reset`).
 * Every one is a plain BasaltRoute: replace or omit any of them freely.
 */
export function authRoutes(): BasaltRoute[] {
  return [
    route({
      method: 'POST',
      url: '/auth/register',
      body: credentials,
      async handler({ body, reply }) {
        const user = await auth().register(body.email, body.password)
        return reply.code(201).send(user)
      },
    }),

    route({
      method: 'POST',
      url: '/auth/login',
      body: credentials.extend({ mfaCode: z.string().optional() }),
      async handler({ body }) {
        const { user, tokens } = await auth().login(body.email, body.password, body.mfaCode)
        return { user, ...tokens }
      },
    }),

    route({
      method: 'POST',
      url: '/auth/refresh',
      body: z.object({ refreshToken: z.string() }),
      async handler({ body }) {
        return auth().refresh(body.refreshToken)
      },
    }),

    route({
      method: 'POST',
      url: '/auth/logout',
      body: z.object({ refreshToken: z.string() }),
      async handler({ body, reply }) {
        await auth().revoke(body.refreshToken)
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
      body: z.object({ email: z.string().email() }),
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
      body: z.object({ token: z.string() }),
      async handler({ body }) {
        return { user: await auth().verifyEmail(body.token) }
      },
    }),

    // --- password reset ----------------------------------------------------
    route({
      method: 'POST',
      url: '/auth/password/forgot',
      body: z.object({ email: z.string().email() }),
      async handler({ body }) {
        await auth().requestPasswordReset(body.email)
        return { ok: true }
      },
    }),

    route({
      method: 'POST',
      url: '/auth/password/reset',
      body: z.object({ token: z.string(), password: z.string().min(8) }),
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
      meta: { auth: true },
      body: z.object({
        name: z.string().min(1).max(100),
        scopes: z.array(z.string().min(1)).optional(),
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
      meta: { auth: true },
      async handler() {
        return apiKeys().list(scope())
      },
    }),

    route({
      method: 'DELETE',
      url: '/apikeys/:id',
      meta: { auth: true },
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
      meta: { auth: true },
      async handler() {
        return auth().enrollMfa(currentUserId())
      },
    }),

    route({
      method: 'POST',
      url: '/auth/mfa/activate',
      meta: { auth: true },
      body: z.object({ code: z.string().min(6) }),
      async handler({ body }) {
        return auth().activateMfa(currentUserId(), body.code)
      },
    }),

    route({
      method: 'GET',
      url: '/auth/mfa/status',
      meta: { auth: true },
      async handler() {
        return auth().mfaStatus(currentUserId())
      },
    }),

    route({
      method: 'POST',
      url: '/auth/mfa/disable',
      meta: { auth: true },
      body: z.object({ code: z.string().min(6) }),
      async handler({ body, reply }) {
        await auth().disableMfa(currentUserId(), body.code)
        return reply.code(204).send()
      },
    }),
  ]
}
