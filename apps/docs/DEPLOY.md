# Deploying the docs

The docs are hosted on **Cloudflare Pages** and deployed with `wrangler`.
VitePress is configured with `base: '/'`, so it serves from the domain root.

**Build output:** `apps/docs/.vitepress/dist`
**Build command:** `pnpm --filter docs docs:build`

`docs:build` runs `docs:packages` first, which mirrors every public package's
`README.md` into `apps/docs/reference/packages/` (gitignored) plus a generated
sidebar. There is **no typedoc API reference**: the guides and the package
READMEs are the complete, hand-written reference, so a stale generator can never
disagree with them. Nothing has to be compiled first:

```bash
pnpm --filter docs docs:build
```

::: tip Keeping the reference honest
Because the READMEs *are* the API reference, a package whose public options,
error codes or hooks change must have its README updated in the same change —
see the [Ecosystem overview](/reference/packages). The legacy `docs:api` /
`docs:build:full` scripts still exist for one-off local typedoc exploration;
they are not part of the deployed build.
:::

## Search — Algolia DocSearch (optional)

Search falls back to VitePress's built-in **local** index, so no configuration is
required. To switch to Algolia DocSearch, set these in the build environment
(from your DocSearch application); leaving any unset keeps the local index:

```bash
ALGOLIA_APP_ID=...      # DocSearch application id
ALGOLIA_API_KEY=...     # search-only public key
ALGOLIA_INDEX=...       # index name
```

## Cloudflare Pages

No repo config file is needed. Deploys are run by hand with the CLI (you run the
login in this terminal with `!`).

```bash
# 1. build locally
pnpm --filter docs docs:build
# 2. log in (opens a browser)
! npx wrangler login
# 3. first time only — create the project
! npx wrangler pages project create basaltkit-docs --production-branch main
# 4. deploy the built folder
! npx wrangler pages deploy apps/docs/.vitepress/dist --project-name=basaltkit-docs
```

The docs are served at `https://basaltkit-docs.pages.dev`. (Recent `wrangler`
versions no longer auto-create the project on first deploy — hence step 3.)
