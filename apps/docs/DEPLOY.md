# Deploying the docs

The repo is private, so GitHub Pages isn't available on the current plan. The
docs are hosted on a free static host instead. VitePress is configured with
`base: '/'`, so it serves from the domain root on any of these.

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

Pick one host. Each has two paths: a one-off **CLI deploy** (fastest — you run
the login in this terminal with `!`), or **Git integration** (auto-deploys on
every push; connect the repo in the host's dashboard using the build settings
above).

## Cloudflare Pages (recommended)

Great free tier, works with private repos. No repo config file needed.

```bash
# 1. build locally (or let CI do it)
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

## Netlify

`netlify.toml` at the repo root already has the build settings.

```bash
! npx netlify-cli login
! npx netlify-cli deploy --build --prod --dir apps/docs/.vitepress/dist
```

## Vercel

`vercel.json` at the repo root already has the build settings.

```bash
! npx vercel login
! npx vercel deploy --prod
```

## Switching back to GitHub Pages later

If the repo is made public (or the plan upgraded), re-add the `push` trigger to
`.github/workflows/docs.yml`, set `base: '/basalt/'` in
`apps/docs/.vitepress/config.ts`, and enable Pages with source “GitHub Actions”.
