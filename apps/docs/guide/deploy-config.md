# `deploy.config.ts` reference

Every option of `deploy.config.ts`, the file `@basaltkit/deploy` reads on each
`plan` and `run`. It sits at the app root, is committed, and holds **no
secrets**: secrets live in the server's `.env`, which the deploy writes and
keeps.

`basalt-deploy init --domain=<host>` writes a first version from the project.
`basalt-deploy check` validates it without a server. For the whole flow, from a
fresh server to everyday deploys, see [Deploying to a server](/guide/deploy).

[[toc]]

## A complete example {#example}

```ts
import type { env } from './src/env.js'   // type only: the app is never loaded
import { apache, ask, defineDeploy, dockerInfra, pm2, secret } from '@basaltkit/deploy'

export default defineDeploy<typeof env>({
  app: 'acme',
  domain: 'acme.example.com',
  tenants: 'subdomain',
  branch: 'main',
  env: {
    schema: 'src/env.ts',
    fixed: { NODE_ENV: 'production', HOST: '127.0.0.1' },
    generate: { APP_SECRET: secret(32) },
    ask: {
      SMTP_URL: ask.secret('SMTP URL', { optional: true }),
      PAYCO_SECRET_TOKEN: ask.secret('PayCo token'),
    },
    derive: ({ domain }) => ({ PAYCO_CALLBACK_URL: `https://${domain}/api/webhooks/payco` }),
    forbid: ['PAYCO_FAKE'],
  },
  infra: dockerInfra('acme', {
    postgres: { urlParams: { schema: 'public' } },
    seaweedfs: { buckets: ['acme-documents'] },
  }),
  build: { prisma: ['prisma.config.ts'], script: 'build', web: 'web' },
  migrate: { central: true, tenants: true },
  backup: { keep: 10 },
  runtime: pm2({ avoid: [3000] }),
  proxy: apache(),
  health: { path: '/health', timeoutSeconds: 60 },
})
```

## `defineDeploy` and typed keys {#define-deploy}

`defineDeploy(config)` returns the config unchanged. It exists for the types.
Give it the type of your `defineEnv(...)`, and every `.env` key the config names
is completed and checked by your editor and by `basalt-deploy check`:

- **Keys checked:** `env.fixed`, `generate`, `ask`, `derive`, `migrate.env`, `backup.urlKey`, and the infra `urlKey` and `keys`.
- **Values typed by the schema:** a `z.enum` completes its members, a number takes digits, a boolean takes `'true' | 'false'`.

```ts
export default defineDeploy<typeof env>({
  env: { fixed: { NODE_ENV: 'prod' } },  // ✗ not "development" | "production" | "test"
  backup: { urlKey: 'DATABSE_URL' },      // ✗ Did you mean "DATABASE_URL"?
  // …
})
```

Without the type argument every key is a plain string.

## Top-level options {#top-level}

| Option | Required | Default | What it is |
|---|---|---|---|
| [`app`](#app) | yes | — | The label that names everything the deploy owns |
| [`domain`](#domain) | yes | — | The host the app answers on |
| [`tenants`](#tenants) | | `'none'` | `'subdomain'` when tenants live on `<id>.<domain>` |
| [`branch`](#branch) | | `'main'` | The branch a deploy fetches |
| [`remote`](#branch) | | `'origin'` | The git remote it fetches from |
| [`env`](#env) | yes | — | The `.env`: where it lives and what the deploy keeps in it |
| [`infra`](#infra) | | none | Postgres, Redis and S3 storage: `dockerInfra()` or `external()` |
| [`build`](#build) | | nothing built | Prisma clients, the app's build script, the frontend |
| [`migrate`](#migrate) | | nothing migrated | Which migrations run |
| [`backup`](#backup) | | dump when migrating | The `pg_dump` before migrating |
| [`runtime`](#runtime) | yes | — | How the app runs: `pm2()` or `compose()` |
| [`proxy`](#proxy) | | `none()` | What sits in front: `apache()`, `caddy()` or `none()` |
| [`health`](#health) | | `/health`, 60 s | The check that decides whether a release is live |
| [`verify`](#verify) | | none | More checks after the health check |
| [`hooks`](#hooks) | | none | The app's own commands at fixed points |
| [`destructive`](#destructive) | | `[]` | Migrations that block an automatic rollback |
| [`system`](#system) | | none | apt packages the app needs on the server |
| [`bootstrap`](#bootstrap) | | swap 4 GB, firewall on | What `bootstrap` sets up on a fresh server |
| [`audit`](#audit) | | no syslog | Also log each release to syslog |

## `app` {#app}

The owner label, matching `[a-z][a-z0-9-]{1,30}`. It names every process,
container, volume, vhost and backup the deploy creates: `acme-api` (pm2),
`acme-pg`, `acme-redis`, `acme-seaweedfs`, `acme.conf`.

The deploy only ever touches what carries this label: a pm2 process name, a
compose image tag or a vhost file outside it is a config error.

## `domain` {#domain}

The lowercase host the app answers on, for example `acme.example.com`. The
deploy uses it to:

- check DNS and the certificate;
- write the vhost;
- run the public health check;
- fill [`env.derive`](#env-derive).

## `tenants` {#tenants}

- `'none'` (default): one host.
- `'subdomain'`: tenants live on `<id>.<domain>`. The wildcard certificate and
  wildcard DNS (`*.<domain>`) are checked too.

Behind [`caddy()`](#caddy), `'subdomain'` requires `onDemandTls`.

## `branch` and `remote` {#branch}

`branch` (default `'main'`) is the branch a deploy fetches from `remote` (default
`'origin'`) and fast-forwards to. A branch name never starts with `-` and holds
only letters, digits and `. _ / + -`. A remote is a remote's name, never a URL.

## `env` {#env}

The `.env` the app runs with. Only `env` itself is required; every option inside it is optional.

| Option | Default | What it does |
|---|---|---|
| `file` | `'.env'` | Where the file lives: relative to the app directory, or absolute directly under `/etc/<app>/`. It is written `0600` and backed up before every change. |
| `mirror` | `[]` | Exact copies of the file, rewritten with it. A copy that differs is an error (C10). |
| `schema` | — | The module that runs the app's `defineEnv(...)`, for example `'src/env.ts'`. The new `.env` is validated against it before migrating. |
| `fixed` | `{}` | Always these values; a different value in the file is corrected. |
| `generate` | `{}` | Generated once when absent, then kept: `secret(bytes)`. |
| `ask` | `{}` | Asked once when absent or empty, then kept: `ask.secret()` or `ask.text()`. |
| `derive` | — | A function that computes values from the deploy on every run. |
| `forbid` | `[]` | Keys that must not exist in the file at all. A key cannot be both forbidden and set. |

### `secret(bytes)` {#secret}

`secret(32)` writes 32 random bytes as hex (64 characters). The default is 32.
The value is generated only when the key is missing, so a rotated secret
is never overwritten.

```ts
generate: { APP_SECRET: secret(), BI_HASH_KEY: secret(48) }
```

### `ask.secret()` and `ask.text()` {#ask}

The questions `run` (or the [UI's `.env` form](/guide/deploy#env-form)) asks
when a key is absent or empty. The answer is then kept.

| Helper | Options | The answer |
|---|---|---|
| `ask.secret(prompt, { optional })` | `optional` (default `false`) | Hidden while typed |
| `ask.text(prompt, { optional, default })` | `optional`, `default` | Shown; `default` is offered |

`optional: true` lets the answer be empty: the app then runs without that value
(for example, mail sent to the log).

### `derive` {#env-derive}

```ts
derive: ({ app, domain, port }) => ({
  PUBLIC_URL: `https://${domain}`,
  PAYCO_CALLBACK_URL: `https://${domain}/api/webhooks/payco`,
}),
```

It receives `{ app, domain, port }` (the resolved runtime port) and returns
values. They are recomputed on every run, so a domain change in
`/etc/basalt/<app>.json` reaches them.

## `infra` {#infra}

The services the app needs. There are two kinds:

- **`dockerInfra(app, options)`:** the deploy creates and keeps dedicated containers.
- **`external(services)`:** the containers already exist; the deploy checks them and maintains what is inside.

### `dockerInfra(app, options)` {#docker-infra}

Dedicated containers on `127.0.0.1` for this app only, named after `app`:
`<app>-pg`, `<app>-redis`, `<app>-seaweedfs`. A server that already runs a
container with that name has it adopted, not duplicated.

The connection URLs are written to the `.env`. On a re-run, an existing
password is kept.

| Option | Default | What it does |
|---|---|---|
| `postgres` | on | Postgres options (below); `false` turns it off |
| `redis` | on | Redis options (below); `false` turns it off |
| `seaweedfs` | off | S3-compatible storage (below); on when given |
| `project` | the app | The compose project the containers belong to. A `compose()` app needs another one, for example `'acme-infra'`. |
| `access` | `'host'` | Who reaches the services through the `.env` URLs. With `'host'`, a process on the host (pm2) gets `127.0.0.1:<port>`. With `'containers'`, the app's containers get `<container>:<internal port>`. |

**`postgres`**

| Option | Default | What it does |
|---|---|---|
| `image` | `'postgres:16'` | The image |
| `port` | `'auto'` | Host port. `'auto'` keeps the running container's, else the `.env` URL's, else the first free one from 5433. |
| `user` / `database` | the app | The owner and the database |
| `urlKey` | `'DATABASE_URL'` | The `.env` key that receives the URL |
| `urlParams` | `{}` | Appended to the URL, for example `{ schema: 'public' }` for Prisma |
| `container` | `<app>-pg` | Adopt a container under another name |
| `appRole` | — | A role without DDL for the app; see [`appRole`](#app-role) |

**`redis`**

| Option | Default | What it does |
|---|---|---|
| `image` | `'redis:7-alpine'` | The image |
| `port` | `'auto'` | As for Postgres, from 6380 |
| `urlKey` | `'REDIS_URL'` | The `.env` key that receives the URL (with a generated password) |
| `container` | `<app>-redis` | Adopt a container under another name |

**`seaweedfs`**

S3-compatible object storage in one container. Only the S3 API is published,
on `127.0.0.1`.

| Option | Default | What it does |
|---|---|---|
| `image` | `'chrislusf/seaweedfs:4.48'` | Pinned: an upgrade is a decision |
| `port` | `'auto'` | As for Postgres, from 8333 |
| `accessKey` | the app | The access key a new store gets |
| `buckets` | `[]` | Created and kept; see [Buckets](#buckets) |
| `keys` | `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | The `.env` keys that receive the endpoint and the credentials |
| `container` | `<app>-seaweedfs` | Adopt a container under another name |

```ts
infra: dockerInfra('acme', {
  redis: false,
  postgres: { image: 'postgres:17', urlParams: { schema: 'public' } },
  seaweedfs: { buckets: ['acme-documents', { name: 'acme-backups', versioned: true }] },
}),
```

### `external(services)` {#external}

Containers this deploy does not create, because their data outlives any
release. The deploy still:

- checks that they run, in the preflight;
- maintains the app's database role and the buckets on every deploy;
- dumps the database before migrating.

`external()` with no services means "nothing to do".

| Service | Options |
|---|---|
| `postgres` | `container` (required); `urlKey` (default `'DATABASE_URL'`): the key holding the **owner's** URL, used for the role, the grants and the dump; `appRole` |
| `redis` | `container` |
| `s3` | `keys` (as for SeaweedFS); `buckets`; `hostEndpoint`: where the deploy reaches the store when the `.env` endpoint only resolves inside containers, for example `'http://127.0.0.1:8333'` |

```ts
infra: external({
  postgres: { container: 'globex-postgres', appRole: { name: 'globex_app', urlKey: 'APP_DATABASE_URL' } },
  s3: { buckets: ['globex-files'], hostEndpoint: 'http://127.0.0.1:8333' },
}),
```

### `appRole` {#app-role}

`{ name, urlKey }`: the role the app connects as, with no DDL and no superuser.
The deploy:

- creates the role when it is missing;
- keeps its password equal to the URL at `urlKey`, and generates that URL when absent;
- grants it DML through the owner's default privileges.

Migrations still run as the owner. `name` is a lowercase Postgres identifier.

### Buckets {#buckets}

A bucket is a name (`'acme-documents'`) or an object with a policy, applied once:

| Field | What it does |
|---|---|
| `name` | A valid S3 bucket name (`[a-z0-9][a-z0-9.-]{2,62}`) |
| `versioned` | `true` turns versioning on |
| `expireDays` | Adds an expiry rule (a whole number ≥ 1) |

## `build` {#build}

| Option | What it does |
|---|---|
| `prisma` | Prisma config files, each run with `prisma generate --config <file>` |
| `script` | The package.json script that compiles the app, run after `prisma generate`. A create-basalt app needs `'build'`, because its `start` runs `dist/`. |
| `web` | A frontend directory, built with `<pm> --dir <web> build` |

## `migrate` {#migrate}

| Option | What it does |
|---|---|
| `central` | `true`: `prisma migrate deploy` with the root Prisma config |
| `tenants` | `true`: `<pm> basalt tenant:migrate`. An array of strings: those package.json script arguments instead. |
| `command` | The app's own migration command, run in the checkout **instead of** `central`/`tenants`, for example `['pnpm', 'db:deploy']` |
| `env` | `(values) => ({ … })`: values that override the `.env` for the migration and the dump |

`env` is for URLs that name a container but must reach it from the host:

```ts
migrate: {
  central: true,
  env: (values) => ({
    DATABASE_URL: values.get('DATABASE_URL')?.replace('@globex-postgres:5432', '@127.0.0.1:5433'),
  }),
},
```

## `backup` {#backup}

The `pg_dump` taken before migrating. When a migration fails, the restore
command points at it.

| Option | Default | What it does |
|---|---|---|
| `beforeMigrate` | unset | Unset: dump when something is migrated and there is a Postgres. `true`/`false` force it either way. |
| `keep` | `10` | Dumps kept; older ones are removed |
| `dir` | `<stateDir>/backups` | Relative to the checkout. The default is `/var/lib/basalt/<app>/backups` (`0700`) once `install` ran: outside the checkout, so never in an image or a commit. |
| `urlKey` | `'DATABASE_URL'` | With external infra: the key holding the database URL |
| `container` | — | With external infra: dump inside this container (`docker exec`), with the server's own `pg_dump` |

For backups on a schedule, see [PostgreSQL backups](/guide/backup).

## `runtime` {#runtime}

How the app runs. Required: `pm2()` or `compose()`.

### `pm2(options)` {#pm2}

| Option | Default | What it does |
|---|---|---|
| `name` | `<app>-api` | The pm2 process name; must start with `<app>-` |
| `script` | `'start'` | The package.json script the process runs |
| `port` | `'auto'` | `'auto'` keeps the `.env`'s `PORT`, else picks the first free port from 3000 |
| `avoid` | `[]` | Ports `'auto'` never picks |
| `loadEnv` | `true` | Gives the app its `env.file`; see below |

The process always gets `NODE_ENV`, `PORT` and `HOST` from pm2. With `loadEnv`
on, it also gets the file's path and a preload that loads the file inside the
app's own processes only. The values never reach the pm2 daemon or `pm2 save`'s
dump. [How the app gets its `.env`](/guide/deploy#env-file) has the details.

`loadEnv: false` is for an app that loads its environment itself. The preflight
warns when the start script shows no loader.

### `compose(options)` {#compose}

A Docker Compose project, its images built for each commit.

| Option | Default | What it does |
|---|---|---|
| `file` | — | The compose file, relative to the checkout |
| `images` | — | At least one `{ tag, dockerfile, context?, env }`. Each is built as `<tag>:<sha>`, and the tag is `<app>` or starts with `<app>-`. `env` is the compose variable that receives `<tag>:<sha>`. `context` defaults to `.`. |
| `upstream` | — | `{ service, port }`: what the proxy and the health check reach on `127.0.0.1` |
| `env` | `{}` | Compose interpolation values; never secrets |
| `passEnv` | — | `.env` keys handed to compose for `${KEY}` interpolation, in its environment only |
| `keepImages` | `3` | Releases whose images are kept for a rollback without a rebuild |
| `attach` | — | `{ container: [networks] }`: containers this project does not own, connected to its networks before `up` |
| `jobs` | — | One-off commands before `up`, with this commit's images; see below |

A **job** is `{ service, command?, once? }`. It runs as
`docker compose run --rm --no-deps <service> [command]`. `once: { exists: '/path/glob' }`
skips it when that path already exists inside the container.

```ts
runtime: compose({
  file: 'docker-compose.prod.yml',
  images: [{ tag: 'acme-api', dockerfile: 'docker/api/Dockerfile', env: 'API_IMAGE' }],
  upstream: { service: 'api', port: 3000 },
  attach: { 'acme-pg': ['data'] },
  jobs: [{ service: 'clamav', command: ['freshclam'], once: { exists: '/var/lib/clamav/main.c?d' } }],
}),
infra: dockerInfra('acme', { project: 'acme-infra', access: 'containers' }),
```

With `compose()` and `dockerInfra()`, `infra.project` must differ from the app
name. Otherwise the two projects would remove each other's containers as
orphans.

## `proxy` {#proxy}

What sits in front of the app: `apache()`, `caddy()` or `none()` (the default).

### `apache(options)` {#apache}

| Option | Default | What it does |
|---|---|---|
| `webRoot` | `'web/dist'` | Directory served at `/`, relative to the checkout |
| `apiPrefix` | `'/api'` | Path prefix proxied to the app (stripped) |
| `vhost` | `<app>.conf` | File name under `sites-available/`; `<app>.conf` or starting with `<app>-` |
| `certName` | the domain | Let's Encrypt certificate name (`/etc/letsencrypt/live/<name>/`) |
| `root` | `/etc/apache2` | Apache's configuration directory |
| `managed` | `true` | `false`: the vhosts are the app's own; see below |
| `vhosts` | — | With `managed: false`: the `*.conf` files to check |

`install` writes the managed vhost; deploys diff it and never rewrite it. With
`managed: false` the deploy never renders or writes a vhost. On every deploy it
checks that:

- each file is linked in `sites-enabled` (C2);
- every `ProxyPass` to `127.0.0.1` targets the app's port (C1).

### `caddy(options)` {#caddy}

| Option | Default | What it does |
|---|---|---|
| `webRoot` | `'web/dist'` | Directory served at `/` |
| `apiPrefix` | `'/api'` | Path prefix proxied to the app (stripped) |
| `onDemandTls` | — | `{ ask: '/tls/allowed' }`: a certificate per host, issued only when `GET <ask>?domain=<host>` answers 200. Required for `tenants: 'subdomain'`. |
| `extra` | — | Caddyfile text appended to the site file as is (no `import`) |
| `managed` | `true` | `false`: the site file is the app's own, checked and never written |
| `root` | `/etc/caddy` | Caddy's configuration directory |

`install` writes `/etc/caddy/sites/<app>.caddy` and reloads Caddy after
`caddy validate`. TLS is Caddy's own.

### `none()` {#none}

No proxy: the app answers on `127.0.0.1:<port>` only, and the public health
check is skipped.

## `health` {#health}

| Option | Default | What it does |
|---|---|---|
| `path` | `'/health'` | Path on the app itself, without the proxy prefix |
| `timeoutSeconds` | `60` | How long a new release may take to answer before it is rolled back |
| `public` | `true` with a proxy | Also check `https://<domain><apiPrefix><path>`, which is what users reach |

## `verify` {#verify}

Declarative checks after the health check. A failure is a failed release, which
is rolled back.

| Option | What it does |
|---|---|
| `http` | More app URLs, each answering `expect` (default 200): `[{ path: '/readyz' }]` |
| `logs` | Per compose service, text that must not appear in its logs since the release started: `{ 'ingest-worker': ['ECONNREFUSED'] }` |

## `hooks` {#hooks}

Commands only this app needs. Each is an array of strings: a command and its
arguments, with no shell. They run:

- in the checkout, as the deploy user;
- with the `.env` values plus `DEPLOY_SHA` and `DEPLOY_APP` in their environment;
- on every deploy, so they must be idempotent.

| Point | When | A failure |
|---|---|---|
| `infra` | After the `.env` and the infra, before the build | Stops the deploy, and the code is put back |
| `verify` | After the health check | Fails the release, which is rolled back |

```ts
hooks: {
  infra: [['pnpm', 'tsx', 'scripts/ensure-search-index.ts']],
  verify: [['pnpm', 'tsx', 'scripts/smoke.ts']],
},
```

## `destructive` {#destructive}

Migration directory names that cannot run under the previous release's code,
for example `'20261011_drop_legacy'`. A release that applies one is never
rolled back automatically: the health failure prints the restore command for the
pre-migration dump instead.

## `system` {#system}

`{ packages: [...] }`: Debian/Ubuntu apt packages the app needs outside
`node_modules`, such as binaries it spawns or libraries it loads. Give names
only, each once, with no version.

Every deploy checks them (C12) before building, but never installs them: root
installs them through `bootstrap` or `install`, from the install plan.

```ts
system: { packages: ['tesseract-ocr', 'tesseract-ocr-por', 'poppler-utils'] },
```

## `bootstrap` {#bootstrap}

What `basalt-deploy bootstrap` sets up on a fresh server.

| Option | Default | What it does |
|---|---|---|
| `swapGb` | `4` | Swap created when RAM is under 6 GB and there is none; `0` means never |
| `firewall` | `true` | ufw: SSH, plus 80/443 behind a proxy. Turned on only when nothing else listens. |

## `audit` {#audit}

Every release record already says who ran it (`--actor` or `$USER`), from where
(`$SSH_CONNECTION`) and how. `audit: { syslog: true }` also sends one line per
release to the system log (`logger -t basalt-deploy`).

## Per-server overrides: `/etc/basalt/<app>.json` {#overrides}

What is true of one server only, and so cannot be committed, goes in
`/etc/basalt/<app>.json`. It holds data only, and unknown keys are an error.

| Key | Overrides |
|---|---|
| `domain` | `domain` |
| `branch` | `branch` |
| `port` | `pm2({ port })`, or `compose({ upstream.port })` |
| `infra.postgres.port`, `infra.redis.port`, `infra.seaweedfs.port` | The `dockerInfra()` ports |

```json
{ "port": 3005, "infra": { "postgres": { "port": 5434 } } }
```

## See also {#see-also}

- [Deploying to a server](/guide/deploy): the whole flow, the commands and the UI.
- [How the app gets its `.env`](/guide/deploy#env-file).
- The [`DeployConfig` API reference](/reference/api/deploy/src/interfaces/DeployConfig), generated from the source.
