# @machize/api-keys-ui

Self-contained HTML page to **manage API keys** for [`@machize/auth`](https://www.npmjs.com/package/@machize/auth): create (shows the key **once**), list and revoke — **zero dependencies, no build step**. You need this module when you want to give users a screen to manage their API keys without building the UI from scratch.

## What this module solves

`@machize/auth` already exposes the `POST/GET /apikeys` and `DELETE /apikeys/:id` routes (the plaintext key only appears on creation). This module is the **UI** on top of them: a page that lists the keys, lets you create a new one (revealing the secret once, with a copy button) and revoke existing ones.

## Installation

```bash
pnpm add @machize/api-keys-ui
```

Depends on `@machize/core` and `@machize/fastify`. Requires your app to mount the API key routes from `@machize/auth` (`apiKeysPlugin` + `apiKeyRoutes`).

## Getting started in 5 minutes

```ts
import { createApp } from '@machize/core'
import { authPlugin, authRoutes, apiKeysPlugin, apiKeyRoutes, MemoryUserSource } from '@machize/auth'
import { apiKeysUiRoutes } from '@machize/api-keys-ui'
import { fastifyPlugin } from '@machize/fastify'

const app = await createApp({
  plugins: [
    authPlugin({ users: new MemoryUserSource(), secret: process.env.JWT_SECRET! }),
    apiKeysPlugin(),
    fastifyPlugin({
      routes: [
        ...authRoutes(),
        ...apiKeyRoutes(),      // POST/GET /apikeys, DELETE /apikeys/:id
        ...apiKeysUiRoutes(),   // GET /apikeys/ui  ← the page
      ],
    }),
  ],
}).boot()
```

Open **`/apikeys/ui`** (authenticated) and the user can create, view and revoke their keys.

## How it works

The page is served by `GET /apikeys/ui` (requires login). In the browser, it calls the JSON routes with `credentials: 'same-origin'`, so it assumes the user's session is already authenticated against `${apiBase}/apikeys`. When creating a key, it reveals the secret **once** (with a warning and a copy button) — after that only the prefix is visible, as required by `@machize/auth`'s security model.

## API reference

### `apiKeysUiRoutes({ path?, apiBase?, title? })`

Returns the route that serves the page. `path` (default `/apikeys/ui`), `apiBase` (where the JSON routes are, default same-origin), `title`.

### `apiKeysPageHtml({ apiBase?, title? })`

Returns the page's HTML as a string — use it directly if you want to serve it your own way (or on another framework).

## How it connects to other modules

- **`@machize/auth`** — provides the API key routes this page consumes (`apiKeysPlugin` + `apiKeyRoutes`).
- **`@machize/permissions`** — add a *guard* to the page route if you want to restrict who can see it.
