<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/sdk

Type-safe HTTP client for Basalt APIs: describe your endpoints once with Zod and get a client where every call has the right input/output types, structured errors, and automatic session-token refresh. You need this on the frontend (React, Vue, etc.) or in any code that calls your API.

## What this module solves

An **SDK** (Software Development Kit) here means a client library: instead of writing `fetch('https://api...')` by hand everywhere — assembling URLs, headers, and `JSON.stringify` — you call functions with clear names, like `api.projects.create({ body: { name: 'X' } })`.

The classic problem with hand-written clients is **client/server drift**: the backend changes a field, the frontend keeps assuming the old shape, and the error only shows up in production. This package fixes that with a single source of truth: each endpoint is described with `endpoint(...)` using **Zod schemas** (Zod is a validation library that also generates TypeScript types). TypeScript infers the input and output types from that — you never write types by hand — and, at runtime, the server's response is validated against the schema: if it doesn't match, you get a clear error (`CLIENT_RESPONSE_MISMATCH`) instead of silently wrong data.

The client also handles **Bearer** token authentication (the token goes in the `Authorization` header), including the refresh pattern: when the server responds 401 (expired token), it calls your `refresh` function once and retries the request with the new token — transparently to the caller. The package is browser-friendly: its only dependency is Zod (it doesn't even depend on `@basaltkit/core`).

## Installation

```bash
pnpm add @basaltkit/sdk zod
```

> Zod is a *peer dependency* (`^3.24.0` or `^4.0.0` are supported) — you have to install it yourself. The client uses the global `fetch` (browsers and Node 18+); on other runtimes, pass your own implementation via `options.fetch`.

## Get started in 5 minutes

1. Describe the API in a shareable file, for example `src/api.ts`:

```typescript
import { z } from 'zod'
import { endpoint } from '@basaltkit/sdk'

const Project = z.object({ id: z.string(), name: z.string() })

export const api = {
  projects: {
    list: endpoint({ method: 'GET', path: '/projects', result: z.array(Project) }),
    get: endpoint({
      method: 'GET',
      path: '/projects/:id',
      params: z.object({ id: z.string() }),
      result: Project,
    }),
    create: endpoint({
      method: 'POST',
      path: '/projects',
      body: z.object({ name: z.string() }),
      result: Project,
    }),
  },
}
```

2. Create the client and use it:

```typescript
import { createClient } from '@basaltkit/sdk'
import { api } from './api.js'

const client = createClient(api, { baseUrl: 'https://api.example.com' })

const newProject = await client.projects.create({ body: { name: 'Basalt' } })
console.log(newProject.id) // typed: { id: string; name: string }

const one = await client.projects.get({ params: { id: newProject.id } })
const all = await client.projects.list()
```

3. Notice: the client mirrors the shape of the `api` object (`client.projects.create`, …), the arguments are checked by TypeScript, and the response comes back already validated.

## Usage guide

### Body, path parameters, and query string

Each call accepts an object with up to three parts, depending on what the endpoint declares:

- `body` — the request's JSON body (`body` schema);
- `params` — values for the `:name` placeholders in the path (`params` schema); encoded with `encodeURIComponent`;
- `query` — pairs for the `?a=1&b=2` query string (`query` schema); `undefined`/`null` are omitted and arrays repeat the key.

```typescript
import { z } from 'zod'
import { createClient, endpoint } from '@basaltkit/sdk'

const api = {
  search: endpoint({
    method: 'GET',
    path: '/projects',
    query: z.object({ limit: z.number().optional(), tag: z.array(z.string()).optional() }),
    result: z.array(z.object({ id: z.string(), name: z.string() })),
  }),
}

const client = createClient(api, { baseUrl: 'https://api.example.com' })
await client.search({ query: { limit: 10, tag: ['a', 'b'] } })
// → GET /projects?limit=10&tag=a&tag=b
```

Endpoints without `body`, `query`, or `params` are called with no argument: `await client.ping()`.

### Token authentication with automatic refresh

```typescript
import { createClient } from '@basaltkit/sdk'
import { api } from './api.js'

let accessToken: string | undefined
let refreshToken: string | undefined

const client = createClient(api, {
  baseUrl: 'https://api.example.com',
  getToken: () => accessToken, // sent as Authorization: Bearer <token>
  refresh: async () => {
    // called ONCE when a request gets a 401; returns the new token,
    // or null to give up (the 401 is then thrown to the caller)
    if (!refreshToken) return null
    const response = await fetch('https://api.example.com/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })
    if (!response.ok) return null
    const tokens = await response.json()
    accessToken = tokens.accessToken
    refreshToken = tokens.refreshToken
    return tokens.accessToken
  },
})
```

Flow: request → 401 → `refresh()` → retry the request with the new token. If the retry gets a 401 again, the error is thrown (no infinite loop).

### Handling errors

Any non-2xx response (and any response that fails the `result` schema) throws `BasaltClientError`:

```typescript
import { BasaltClientError } from '@basaltkit/sdk'

try {
  await client.projects.get({ params: { id: 'ghost' } })
} catch (error) {
  if (error instanceof BasaltClientError) {
    console.log(error.status)  // 404
    console.log(error.code)    // 'PROJECT_NOT_FOUND' (stable server code)
    console.log(error.message) // 'Project not found'
    console.log(error.details) // the full response body
  }
}
```

`code` comes from `body.error.code` (the Basalt APIs' error convention); without it, it's `'HTTP_ERROR'`. 204 (no content) responses resolve to `undefined`.

### Testing with a fake `fetch`

You don't need a server — inject a fake `fetch` (a real example from the test suite):

```typescript
import { expect, it } from 'vitest'
import { createClient } from '@basaltkit/sdk'
import { api } from './api.js'

it('creates a project', async () => {
  const fetchMock: typeof fetch = async () =>
    new Response(JSON.stringify({ id: 'p1', name: 'Basalt' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })

  const client = createClient(api, { baseUrl: 'https://api.test', fetch: fetchMock })
  const project = await client.projects.create({ body: { name: 'Basalt' } })
  expect(project).toEqual({ id: 'p1', name: 'Basalt' })
})
```

## API reference

Exported from `@basaltkit/sdk`:

### `endpoint(spec): Endpoint`

Describes an endpoint. Returns the object as-is, with generic types captured for inference.

| Field | Type | Required? | Default | Description |
| --- | --- | --- | --- | --- |
| `method` | `'GET' \| 'POST' \| 'PUT' \| 'PATCH' \| 'DELETE'` | Yes | — | HTTP verb |
| `path` | `string` | Yes | — | Path with `:param` placeholders, e.g. `/projects/:id` |
| `body` | `ZodType` | No | — | Request body schema |
| `query` | `ZodType` | No | — | Query string schema |
| `params` | `ZodType` | No | — | Path parameters schema |
| `result` | `ZodType` | No | — | Success response schema — validated client-side to catch drift |

### `createClient(endpoints, options): Client<T>`

Builds the client from a tree of endpoints (nested objects at any depth). Each `Endpoint` leaf becomes an `async` function; each branch becomes an object. Throws `Error` if no `fetch` is available and you didn't pass one.

`ClientOptions`:

| Field | Type | Required? | Default | Description |
| --- | --- | --- | --- | --- |
| `baseUrl` | `string` | Yes | — | API root, e.g. `'https://api.example.com'` (trailing slash is tolerated) |
| `fetch` | `typeof fetch` | No | `globalThis.fetch` | fetch implementation |
| `headers` | `Record<string, string>` | No | — | Headers sent on every request (before authentication) |
| `getToken` | `() => string \| undefined \| Promise<string \| undefined>` | No | — | Current token — attached as `Authorization: Bearer` |
| `refresh` | `() => Promise<string \| null>` | No | — | Called once on a 401 to get a new token; `null` gives up and the 401 is thrown |

### `BasaltClientError`

Error thrown for any non-2xx response or a response that fails the `result` schema. No dependencies (doesn't extend `BasaltError`) to stay lightweight in the browser.

| Property | Type | Description |
| --- | --- | --- |
| `status` | `number` | The response's HTTP status code |
| `code` | `string` | Stable server code (`body.error.code`), `'HTTP_ERROR'` if absent, or `'CLIENT_RESPONSE_MISMATCH'` when the response fails the `result` schema |
| `message` | `string` | Server message (or `statusText`) |
| `details` | `unknown` | The response body (or the `ZodError`, in case of a mismatch) |

### Utility types

| Type | Description |
| --- | --- |
| `Endpoint<B, Q, P, R>` | The shape of an endpoint (generics: body, query, params, result) |
| `EndpointTree` | Nested map of endpoints, mirrored by the client |
| `EndpointInput<E>` | The call's input object — `body` uses the schema's *input* type (you can omit fields with a default), `query`/`params` use the *output* type |
| `EndpointOutput<E>` | The return type — the `result` schema's *output* (or `unknown` without `result`) |
| `Client<T>` | The type of the client generated from tree `T` |
| `HttpMethod` | `'GET' \| 'POST' \| 'PUT' \| 'PATCH' \| 'DELETE'` |
| `FetchLike` | `typeof fetch` |
| `ClientOptions` | Described above |

## Common errors and solutions (FAQ)

**`No fetch implementation available — pass options.fetch.`**
The environment has no global `fetch` (Node < 18, some older bundlers). Pass an implementation: `createClient(api, { baseUrl, fetch: myImplementation })`.

**Error with `code: 'CLIENT_RESPONSE_MISMATCH'`.**
The server's response doesn't match the endpoint's `result` schema — the client and server are out of sync (for example, the backend stopped returning a field). Update the schema on the client or fix the server; `error.details` contains the `ZodError` with the missing fields.

**The request gets a 401 and `refresh` is never called.**
`refresh` only runs if it's defined in `ClientOptions`, and only on the first 401 of each request. Confirm you passed it to `createClient`.

**`refresh` is called but the request still fails with 401.**
The client retries the request **once** with the new token; if it gets a 401 again, it throws the error (protection against loops). Check whether the token returned by `refresh` is actually valid — and return `null` when you can't refresh it (for example, an expired session).

**Path parameters show up unreplaced in the URL (`/projects/:id`).**
Pass them in `params`, not `query`: `client.projects.get({ params: { id: 'p1' } })`, and the name has to match the placeholder in `path`.

**I got `undefined` instead of data.**
204 (No Content) responses resolve to `undefined` by design — typical of DELETE endpoints.

**Can I use this in a Node backend?**
Yes — it works anywhere with `fetch` (Node 18+ includes it). It's useful for calling a Basalt API from another one.

## How it connects to other modules

- **`@basaltkit/fastify`** — the natural counterpart on the other side: server routes are also described with Zod, and the `{ error: { code, message } }` error format from `HttpError` is exactly what the SDK maps to `BasaltClientError.code`.
- **`@basaltkit/auth`** — the backend's `POST /auth/login` and `POST /auth/refresh` endpoints supply the tokens you wire up to `getToken`/`refresh`.
- **`create-basalt`** — with the `--ui` flag, the generated frontend (`web/src/api.ts`) already uses `endpoint` + `createClient` from this package, including token refresh when authentication is enabled.
- **`@basaltkit/core`** — deliberately **not** a dependency: the SDK only depends on Zod, so it can run in the browser without pulling in the framework.
