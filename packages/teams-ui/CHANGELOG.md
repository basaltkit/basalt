# @machize/teams-ui

## 0.24.0

### Patch Changes

- @machize/core@0.24.0
- @machize/fastify@0.24.0

## 0.23.0

### Patch Changes

- @machize/core@0.23.0
- @machize/fastify@0.23.0

## 0.22.0

### Patch Changes

- @machize/core@0.22.0
- @machize/fastify@0.22.0

## 0.21.0

### Patch Changes

- @machize/core@0.21.0
- @machize/fastify@0.21.0

## 0.20.0

### Patch Changes

- @machize/core@0.20.0
- @machize/fastify@0.20.0

## 0.19.0

### Patch Changes

- @machize/core@0.19.0
- @machize/fastify@0.19.0

## 0.18.0

### Minor Changes

- bbfb7ff: New package: `@machize/teams-ui` — a management page for `@machize/teams`.

  `teamsUiRoutes({ path?, apiBase?, title?, roles?, headers? })` serves a self-contained, dependency-free HTML page at `GET /team/ui` (requires a logged-in user) that drives `@machize/teams`' routes: invite a member (`POST /team/invites`), list and revoke pending invitations, and list members with a role dropdown (`PATCH /team/members/:userId`) and remove (`DELETE`). It fetches same-origin; the optional `headers` inject header-based tenancy (`x-tenant-id`), while subdomain apps need nothing. `teamsPageHtml(...)` returns the HTML string for custom serving. Tested (the generated page and the end-to-end HTTP flow against the real team routes with tenancy + auth).

### Patch Changes

- @machize/core@0.18.0
- @machize/fastify@0.18.0
