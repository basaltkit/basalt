import { describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin } from '@basaltkit/fastify'
import { authPlugin, authRoutes, MemoryUserSource } from '../src/index.js'

const boot = async () => {
  const app = await createApp({
    plugins: [
      authPlugin({ users: new MemoryUserSource(), secret: 'test-secret' }),
      fastifyPlugin({ routes: authRoutes() }),
    ],
  }).boot()
  return { app, server: app.container.get(FASTIFY) }
}

describe('auth over HTTP (end to end)', () => {
  it('full flow: register → login → me → refresh → logout', async () => {
    const { app, server } = await boot()
    const credentials = { email: 'ada@example.com', password: 'password123' }

    const registered = await server.inject({ method: 'POST', url: '/auth/register', payload: credentials })
    expect(registered.statusCode).toBe(201)

    const login = await server.inject({ method: 'POST', url: '/auth/login', payload: credentials })
    const { accessToken, refreshToken, user } = login.json()
    expect(user.email).toBe('ada@example.com')

    const me = await server.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    })
    expect(me.json()).toEqual(user)

    const refreshed = await server.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken },
    })
    expect(refreshed.json().refreshToken).not.toBe(refreshToken)

    const logout = await server.inject({
      method: 'POST',
      url: '/auth/logout',
      payload: { refreshToken: refreshed.json().refreshToken },
    })
    expect(logout.statusCode).toBe(204)
    await app.shutdown()
  })

  it('guarded route: anonymous → 401 AUTH_REQUIRED; invalid bearer → 401 token error', async () => {
    const { app, server } = await boot()

    const anonymous = await server.inject({ method: 'GET', url: '/auth/me' })
    expect(anonymous.statusCode).toBe(401)
    expect(anonymous.json().error.code).toBe('AUTH_REQUIRED')

    const invalid = await server.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: 'Bearer not-a-token' },
    })
    expect(invalid.statusCode).toBe(401)
    expect(invalid.json().error.code).toBe('AUTH_TOKEN_INVALID')
    await app.shutdown()
  })

  it('wrong credentials → 401; duplicate registration → 409', async () => {
    const { app, server } = await boot()
    const credentials = { email: 'ada@example.com', password: 'password123' }
    await server.inject({ method: 'POST', url: '/auth/register', payload: credentials })

    const bad = await server.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { ...credentials, password: 'wrong-password' },
    })
    expect(bad.statusCode).toBe(401)
    expect(bad.json().error.code).toBe('AUTH_INVALID_CREDENTIALS')

    const duplicate = await server.inject({ method: 'POST', url: '/auth/register', payload: credentials })
    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.json().error.code).toBe('AUTH_EMAIL_TAKEN')
    await app.shutdown()
  })

  it('session header authenticates and hooks fire', async () => {
    const { app, server } = await boot()
    const logins: string[] = []
    app.hooks.on('auth:login', ({ user }) => void logins.push(user.email))

    const credentials = { email: 'ada@example.com', password: 'password123' }
    await server.inject({ method: 'POST', url: '/auth/register', payload: credentials })
    await server.inject({ method: 'POST', url: '/auth/login', payload: credentials })
    expect(logins).toEqual(['ada@example.com'])

    const auth = app.container.get((await import('../src/index.js')).AUTH)
    const user = await auth.users.findByEmail('ada@example.com')
    const session = await auth.createSession(user!.id)
    const me = await server.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { 'x-session-id': session.id },
    })
    expect(me.json().email).toBe('ada@example.com')
    await app.shutdown()
  })
})
