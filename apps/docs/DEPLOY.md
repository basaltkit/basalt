# Deploying the docs

The repo is private, so GitHub Pages isn't available on the current plan. The
docs are hosted on a free static host instead. VitePress is configured with
`base: '/'`, so it serves from the domain root on any of these.

**Build output:** `apps/docs/.vitepress/dist`
**Build command:** `pnpm --filter docs docs:build`

Pick one host. Each has two paths: a one-off **CLI deploy** (fastest — you run
the login in this terminal with `!`), or **Git integration** (auto-deploys on
every push; connect the repo in the host's dashboard using the build settings
above).

## Cloudflare Pages (recommended)

Great free tier, works with private repos. No repo config file needed.

```bash
# 1. build locally (or let CI do it)
pnpm --filter docs docs:build
# 2. log in (opens a browser) and deploy the folder
! npx wrangler login
! npx wrangler pages deploy apps/docs/.vitepress/dist --project-name=machize-docs
```

First run creates the `machize-docs` project and prints the
`https://machize-docs.pages.dev` URL.

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
`.github/workflows/docs.yml`, set `base: '/machize/'` in
`apps/docs/.vitepress/config.ts`, and enable Pages with source “GitHub Actions”.
