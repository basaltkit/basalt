# Authentication

`@machize/auth` provides complete server-side authentication with the data in
**your** database — no vendor lock-in. Password hashing, JWT with refresh
rotation, sessions and ready-made routes.

## Setup

```ts
import { authPlugin, MemoryUserSource } from '@machize/auth'

authPlugin({
  users: new MemoryUserSource(), // implement UserSource over your database
  secret: process.env.APP_SECRET,
  accessTtl: '15m',
  refreshTtl: '30d',
})
```

## Ready-made routes

Register the built-in routes — each is a plain route you can replace or omit:

```ts
import { authRoutes } from '@machize/auth'
import { fastifyPlugin } from '@machize/fastify'

fastifyPlugin({ routes: [...appRoutes, ...authRoutes()] })
```

This exposes `POST /auth/register`, `/auth/login`, `/auth/refresh`,
`/auth/logout` and `GET /auth/me`.

## Refresh rotation with reuse detection

Every refresh consumes the token and issues a new one in the same family. If a
consumed token comes back — a theft indicator — the whole family is revoked:

```ts
const { tokens } = await auth.login(email, password)
const next = await auth.refresh(tokens.refreshToken) // old token now dead

// replaying the old token throws AUTH_REFRESH_REUSED and kills the family
await auth.refresh(tokens.refreshToken)
```

Passwords are hashed with **scrypt** (memory-hard, zero dependencies); an
argon2id driver can be swapped in via the `PasswordHasher` contract.

## Guarding routes

Declare `meta.auth` on a route; the guard requires an authenticated user and
returns `401 AUTH_REQUIRED` otherwise:

```ts
route({
  method: 'GET',
  url: '/me',
  meta: { auth: true },
  async handler() {
    return ctx().user
  },
})
```

## Events

Each step emits an event — `auth.login`, `auth.login_failed`,
`auth.registered`, `auth.logout` — consumed for free by
[audit](/reference/packages) and notifications.
