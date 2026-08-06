import { ctx, type Container } from '@machize/core'
import { route, type MachizeRoute } from '@machize/fastify'
import { z } from 'zod'
import { AUTH } from './plugin.js'

const credentials = z.object({ email: z.string().email(), password: z.string().min(8) })

const auth = () => (ctx().container as Container).get(AUTH)

/**
 * Ready-made auth routes — register them in fastifyPlugin({ routes }):
 * register · login · refresh · logout · me, plus email verification
 * (`/auth/verify/request`, `/auth/verify`) and password reset
 * (`/auth/password/forgot`, `/auth/password/reset`).
 * Every one is a plain MachizeRoute: replace or omit any of them freely.
 */
export function authRoutes(): MachizeRoute[] {
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
      body: credentials,
      async handler({ body }) {
        const { user, tokens } = await auth().login(body.email, body.password)
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
