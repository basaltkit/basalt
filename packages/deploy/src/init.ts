import { relative } from 'node:path'
import { APP_NAME } from './config.js'
import type { Host } from './host.js'

/**
 * `basalt-deploy init` — writes `deploy.config.ts` from what the project and,
 * with `--server`, this server already say (RFC 0007 §3). It asks only what
 * nothing can tell it: the domain, the tenancy, the branch.
 *
 * Detection reads files; it never imports the app. `src/env.ts` is parsed as
 * text: the keys of its `defineEnv({ … })`, which are secrets, which have a
 * default. The output is a complete config — `check` runs on it before `init`
 * returns.
 */

export interface EnvKeyFact {
  name: string
  /** Declared with `secret(…)`: generated on the server. */
  secret: boolean
  /** `.default(…)`, `.optional()` or `.catch(…)`: the app runs without it. */
  optional: boolean
}

export interface ComposeImageFact {
  tag: string
  dockerfile: string
  context: string
  env: string
}

export interface ComposeFact {
  file: string
  images: ComposeImageFact[]
  upstream: { service: string; port: number } | undefined
  /** Compose interpolation the upstream port came from, e.g. `{ API_HOST_PORT: '3001' }`. */
  env: Record<string, string>
}

export interface ProjectFacts {
  app: string
  env: { schema: string; exportName: string; keys: EnvKeyFact[] } | undefined
  prisma: string[]
  /** `prisma/tenants/…`: schema-per-tenant migrations. */
  tenants: boolean
  /** A `db:deploy` script that is not plain `prisma migrate deploy`. */
  migrateScript: string | undefined
  /** `build`, when `start` runs compiled output (`node dist/…`). */
  buildScript: string | undefined
  web: string | undefined
  compose: ComposeFact | undefined
  server: { vhosts: string[]; busyPorts: number[] } | undefined
  /** `/readyz` when the app declares one (readiness: database and dependencies), else `/health`. */
  health: '/readyz' | '/health'
}

export interface InitAnswers {
  domain: string
  tenants: 'subdomain' | 'none'
  branch: string
  proxy: 'apache' | 'caddy' | 'none'
}

const COMPOSE_FILES = ['docker/compose.prod.yml', 'docker/compose.prod.yaml', 'compose.prod.yml', 'compose.prod.yaml', 'docker-compose.prod.yml']
const PRISMA_CENTRAL = 'prisma.config.ts'
const PRISMA_TENANTS = 'prisma/tenants/prisma.config.ts'
/** Key names whose values are secrets (what `init` asks as `ask.secret`, what JSON mode redacts). */
export const SENSITIVE = /SECRET|TOKEN|PASSW|PASS\b|_PWD(?:_|$)|(?:^|_)KEY(?:_|$)|APIKEY|PRIVATE|(?:^|_)SALT(?:_|$)|CREDENTIAL|_URL$|_DSN$/
/**
 * A `secret()` the app can mint for itself (signing, encryption): generated on
 * the server. One a provider issues (S3, an API, SMTP) is asked instead — a
 * random value would only fail at the first call.
 */
const ISSUED = /S3|AWS|ACCESS_KEY|API_?KEY|TOKEN|SMTP|MAIL|OAUTH|CLIENT|STRIPE|PAYCO|TWILIO|SENDGRID|PASSWORD/

// ── detection ──────────────────────────────────────────────────────────────

export async function detectProject(host: Host, dir: string, options: { server?: string | undefined } = {}): Promise<ProjectFacts> {
  const pkg = parseJson(await host.readFile(`${dir}/package.json`)) as { name?: string; scripts?: Record<string, string> } | undefined
  const scripts = pkg?.scripts ?? {}
  const app = appName(pkg?.name ?? dir.split('/').pop() ?? 'app')

  const prisma: string[] = []
  if (await host.stat(`${dir}/${PRISMA_CENTRAL}`)) prisma.push(PRISMA_CENTRAL)
  const tenants = Boolean(await host.stat(`${dir}/${PRISMA_TENANTS}`))
  if (tenants) prisma.push(PRISMA_TENANTS)
  const dbDeploy = scripts['db:deploy']
  const migrateScript = dbDeploy !== undefined && dbDeploy.trim() !== 'prisma migrate deploy' ? 'db:deploy' : undefined

  const buildScript = scripts['build'] !== undefined && /\bnode\b[^&|;]*\bdist\//.test(scripts['start'] ?? '') ? 'build' : undefined
  const web = (await host.stat(`${dir}/web/package.json`)) ? 'web' : undefined
  const envSource = await host.readFile(`${dir}/src/env.ts`)
  const env = envSource === undefined ? undefined : parseEnvSchema(envSource)

  let compose: ComposeFact | undefined
  for (const file of COMPOSE_FILES) {
    if (!(await host.stat(`${dir}/${file}`))) continue
    compose = await detectCompose(host, dir, file, app)
    if (compose) break
  }
  const server = options.server === undefined ? undefined : await detectServer(host, options.server)
  const grep = await host.exec('grep', ['-rlE', `['"\`]/readyz['"\`]`, 'src'], { cwd: dir })
  return {
    health: grep.code === 0 && grep.stdout.trim() !== '' ? '/readyz' : '/health',
    app,
    env: env && { schema: 'src/env.ts', ...env },
    prisma,
    tenants,
    migrateScript,
    buildScript,
    web,
    compose,
    server,
  }
}

/** `@acme/My App` → `my-app`, within C4's `[a-z][a-z0-9-]{1,30}`. */
export function appName(name: string): string {
  const base = slugOf(name)
  return APP_NAME.test(base) ? base : 'app'
}

/** Lowercase, hyphens for the rest, starting with a letter, no trailing hyphen, at most 31 characters — trimmed in linear time (an anchored `-+$` regex backtracks on long runs of '-'). */
function slugOf(name: string): string {
  const base = name.replace(/^@[^/]+\//, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
  let start = 0
  while (start < base.length && !((base[start] as string) >= 'a' && (base[start] as string) <= 'z')) start++
  let end = Math.min(base.length, start + 31)
  while (end > start && base[end - 1] === '-') end--
  return base.slice(start, end)
}

/** The keys of the first `defineEnv({ … })` in `source`, read as text. */
export function parseEnvSchema(source: string): { exportName: string; keys: EnvKeyFact[] } | undefined {
  const call = /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*defineEnv\s*\(\s*\{/.exec(source)
  if (!call) return undefined
  const body = objectBody(source, call.index + call[0].length - 1)
  const keys: EnvKeyFact[] = []
  // Top-level entries only: depth 0 inside the object literal.
  let depth = 0
  let start = 0
  const entries: string[] = []
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === '"' || c === "'" || c === '`') { i = skipString(body, i); continue }
    if (c === '/' && body[i + 1] === '/') { const end = body.indexOf('\n', i); i = end === -1 ? body.length : end; continue }
    if (c === '/' && body[i + 1] === '*') { const end = body.indexOf('*/', i + 2); i = end === -1 ? body.length : end + 1; continue }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === ',' && depth === 0) { entries.push(body.slice(start, i)); start = i + 1 }
  }
  entries.push(body.slice(start))
  for (const raw of entries) {
    const entry = raw.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').trim()
    const match = /^([A-Z][A-Z0-9_]*)\s*:\s*([\s\S]+)$/.exec(entry)
    if (!match) continue
    const expression = match[2] as string
    keys.push({
      name: match[1] as string,
      secret: /\bsecret\s*\(/.test(expression),
      optional: /\.(default|optional|catch)\s*\(/.test(expression),
    })
  }
  return { exportName: call[1] as string, keys }
}

function objectBody(source: string, open: number): string {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const c = source[i]
    if (c === '"' || c === "'" || c === '`') { i = skipString(source, i); continue }
    if (c === '/' && source[i + 1] === '/') { const end = source.indexOf('\n', i); i = end === -1 ? source.length : end; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return source.slice(open + 1, i) }
  }
  return source.slice(open + 1)
}

function skipString(text: string, at: number): number {
  const quote = text[at]
  for (let i = at + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue }
    if (text[i] === quote) return i
  }
  return text.length
}

interface ComposeJson {
  services?: Record<string, {
    image?: string
    build?: { context?: string; dockerfile?: string } | null
    ports?: (string | { host_ip?: string; published?: string | number; target?: number })[] | null
  }>
}

/**
 * The compose file as `docker compose config` reads it, interpolation off. It
 * is the app's runtime only when it runs images of this app — services whose
 * `image:` is a variable (`${APP_IMAGE}`), which the deploy sets to
 * `<tag>:<sha>`; a file of infra only (postgres:16, redis) is not. Each
 * variable is one image: its Dockerfile from `build:`, else by convention
 * (`docker/<name>/Dockerfile`, `Dockerfile`). The service that publishes on
 * 127.0.0.1 is the upstream.
 */
async function detectCompose(host: Host, dir: string, file: string, app: string): Promise<ComposeFact | undefined> {
  const result = await host.exec('docker', ['compose', '-f', file, 'config', '--no-interpolate', '--format', 'json'], { cwd: dir })
  if (result.code !== 0) {
    throw new Error(`${file} found, but docker compose cannot read it: ${result.stderr.trim().split('\n')[0] ?? ''} — init reads the compose file with docker compose`)
  }
  const config = parseJson(result.stdout) as ComposeJson | undefined
  const services = Object.entries(config?.services ?? {})
  const variables = new Map<string, { services: string[]; build: { context?: string; dockerfile?: string } | undefined }>()
  for (const [service, spec] of services) {
    const variable = /^\$\{([A-Za-z_][A-Za-z0-9_]*)/.exec(spec.image ?? '')?.[1]
    if (!variable) continue
    const seen = variables.get(variable) ?? { services: [], build: undefined }
    seen.services.push(service)
    seen.build ??= spec.build ?? undefined
    variables.set(variable, seen)
  }
  if (variables.size === 0) return undefined

  const dockerDirs = (await host.list(`${dir}/docker`).catch(() => [])).filter((d) => !d.includes('.'))
  // ACME_IMAGE, ACME_SCANNER_IMAGE → the shared ACME_ is the app's prefix,
  // whatever the package is called; what is left names the image.
  const stems = [...variables.keys()].map((v) => v.replace(/_IMAGE$/, '').split('_'))
  let shared = 0
  if (stems.length === 1) shared = (stems[0] as string[]).length
  else while (stems.every((t) => t[shared] !== undefined && t[shared] === (stems[0] as string[])[shared])) shared++
  const images: ComposeImageFact[] = []
  const unresolved: string[] = []
  for (const [variable, { services: users, build }] of variables) {
    const stem = variable.replace(/_IMAGE$/, '').split('_').slice(shared).join('-').toLowerCase()
    const tag = stem ? `${app}-${stem}` : app
    let dockerfile: string | undefined
    let context: string | undefined
    if (build) {
      context = relative(dir, build.context ?? dir) || '.'
      dockerfile = context === '.' ? build.dockerfile ?? 'Dockerfile' : `${context}/${build.dockerfile ?? 'Dockerfile'}`
    } else {
      const names = stem ? [stem, ...users] : ['app', 'api', ...users]
      const near = (d: string) => names.some((n) => d === n || (n.length >= 4 && d.startsWith(n.slice(0, 4))))
      const found = [...dockerDirs.filter((d) => names.includes(d)), ...dockerDirs.filter(near)]
      for (const d of found) if (!dockerfile && (await host.stat(`${dir}/docker/${d}/Dockerfile`))) dockerfile = `docker/${d}/Dockerfile`
      if (!dockerfile && !stem && (await host.stat(`${dir}/Dockerfile`))) dockerfile = 'Dockerfile'
      if (dockerfile) {
        // A Dockerfile that copies the app's own files builds from the root;
        // one that copies only what sits next to it, from its directory.
        const text = (await host.readFile(`${dir}/${dockerfile}`)) ?? ''
        const own = dockerfile.replace(/\/?Dockerfile$/, '') || '.'
        context = /^\s*COPY\s+(?:--\S+\s+)*(?:package\.json|pnpm-lock\.yaml|src\b|\.\s)/m.test(text) ? '.' : own
      }
    }
    if (!dockerfile || !context) { unresolved.push(`${variable} (${users.join(', ')})`); continue }
    images.push({ tag, dockerfile, context, env: variable })
  }
  if (unresolved.length) {
    throw new Error(`${file}: no Dockerfile found for ${unresolved.join(', ')} — add build: { context, dockerfile } to the service, or put it in docker/<name>/Dockerfile`)
  }
  // The app's own image first: it is the one named after the app.
  images.sort((a, b) => (a.tag === app ? -1 : b.tag === app ? 1 : 0))

  const env: Record<string, string> = {}
  let upstream: ComposeFact['upstream']
  for (const [service, spec] of services) {
    for (const port of spec.ports ?? []) {
      if (upstream) break
      let published: string
      if (typeof port === 'string') {
        const short = /^127\.0\.0\.1:(.+):\d+(?:\/tcp)?$/.exec(port)
        if (!short) continue
        published = short[1] as string
      } else {
        if (port.host_ip !== '127.0.0.1') continue
        published = String(port.published ?? '')
      }
      const interpolated = /^\$\{([A-Za-z_][A-Za-z0-9_]*):?-(\d+)\}$/.exec(published)
      const number = Number(interpolated ? interpolated[2] : published)
      if (!Number.isInteger(number) || number <= 0) continue
      upstream = { service, port: number }
      if (interpolated) env[interpolated[1] as string] = interpolated[2] as string
    }
  }
  return { file, images, upstream, env }
}

async function detectServer(host: Host, domain: string): Promise<{ vhosts: string[]; busyPorts: number[] }> {
  const vhosts: string[] = []
  for (const name of (await host.list('/etc/apache2/sites-available').catch(() => [])).sort()) {
    if (!name.endsWith('.conf')) continue
    const text = await host.readFile(`/etc/apache2/sites-available/${name}`)
    const served = [...(text ?? '').matchAll(/^\s*Server(?:Name|Alias)\s+(.+)$/gim)].flatMap((m) => (m[1] as string).trim().split(/\s+/))
    if (served.some((h) => h === domain || h === `*.${domain}`)) vhosts.push(name)
  }
  const ss = await host.exec('ss', ['-ltnH'], {})
  const busyPorts = [...new Set([...ss.stdout.matchAll(/:(\d+)\s/g)].map((m) => Number(m[1])).filter((p) => p >= 3000 && p < 3100))].sort((a, b) => a - b)
  return { vhosts, busyPorts }
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined
  try { return JSON.parse(text) } catch { return undefined }
}

// ── the file ───────────────────────────────────────────────────────────────

/** Keys the deploy writes itself, never generated or asked. */
function managedKeys(facts: ProjectFacts): Set<string> {
  const keys = new Set(['NODE_ENV'])
  if (!facts.compose) {
    for (const key of ['PORT', 'HOST', 'DATABASE_URL', 'REDIS_URL']) keys.add(key)
    if (hasMinio(facts)) for (const key of MINIO_KEYS) keys.add(key)
  }
  return keys
}

/** What `dockerInfra`'s MinIO writes (`minio.keys`); all three in the schema → a dedicated MinIO. */
const MINIO_KEYS = ['S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY']
const hasMinio = (facts: ProjectFacts) => MINIO_KEYS.every((k) => facts.env?.keys.some((e) => e.name === k))

export function renderConfig(facts: ProjectFacts, answers: InitAnswers): string {
  const helpers = new Set(['defineDeploy'])
  const lines: string[] = []
  const typed = facts.env !== undefined
  const keys = facts.env?.keys ?? []
  const has = (name: string) => keys.some((k) => k.name === name)
  const managed = managedKeys(facts)

  const fixed: string[] = []
  if (has('NODE_ENV') || !typed) fixed.push(`NODE_ENV: 'production'`)
  if (!facts.compose && has('HOST')) fixed.push(`HOST: '127.0.0.1'`)
  const minted = (k: EnvKeyFact) => k.secret && !ISSUED.test(k.name)
  const generate = keys.filter((k) => minted(k) && !managed.has(k.name)).map((k) => `${k.name}: secret(32)`)
  const ask = keys.filter((k) => !minted(k) && (k.secret || !k.optional) && !managed.has(k.name))
    .map((k) => `${k.name}: ask.${k.secret || SENSITIVE.test(k.name) ? 'secret' : 'text'}(${quote(label(k.name, facts.app))})`)
  if (generate.length) helpers.add('secret')
  if (ask.length) helpers.add('ask')

  lines.push(`  app: ${quote(facts.app)},`)
  lines.push(`  domain: ${quote(answers.domain)},`)
  if (answers.tenants === 'subdomain') lines.push(`  tenants: 'subdomain',`)
  if (answers.branch !== 'main') lines.push(`  branch: ${quote(answers.branch)},`)
  lines.push('')
  lines.push('  env: {')
  if (facts.env) lines.push(`    schema: ${quote(facts.env.schema)},`)
  lines.push(`    fixed: { ${fixed.join(', ')} },`)
  if (generate.length) lines.push(...block('generate', generate))
  if (ask.length) lines.push(...block('ask', ask))
  lines.push('  },')

  if (!facts.compose && (has('DATABASE_URL') || has('REDIS_URL') || hasMinio(facts) || !typed)) {
    helpers.add('dockerInfra')
    const options: string[] = []
    if (typed && !has('DATABASE_URL')) options.push('postgres: false')
    if (typed && !has('REDIS_URL')) options.push('redis: false')
    if (hasMinio(facts)) options.push('minio: {}')
    lines.push(`  infra: dockerInfra(${quote(facts.app)}${options.length ? `, { ${options.join(', ')} }` : ''}),`)
  }

  const build: string[] = []
  if (facts.prisma.length) build.push(`prisma: [${facts.prisma.map(quote).join(', ')}]`)
  if (facts.buildScript && !facts.compose) build.push(`script: ${quote(facts.buildScript)}`)
  if (facts.web) build.push(`web: ${quote(facts.web)}`)
  if (build.length) lines.push(`  build: { ${build.join(', ')} },`)

  if (facts.migrateScript) lines.push(`  migrate: { command: ['pnpm', ${quote(facts.migrateScript)}] },`)
  else if (facts.prisma.length) lines.push(`  migrate: { central: true${facts.tenants ? ', tenants: true' : ''} },`)
  lines.push('')

  if (facts.compose) {
    helpers.add('compose')
    const c = facts.compose
    if (!c.upstream) throw new Error(`${c.file}: no service publishes a port on 127.0.0.1 — the proxy needs one (ports: ["127.0.0.1:3001:3000"])`)
    if (!c.images.length) throw new Error(`${c.file}: no service is built here with image: \${VAR} — the deploy tags each image per commit through that variable`)
    lines.push('  runtime: compose({')
    lines.push(`    file: ${quote(c.file)},`)
    lines.push('    images: [')
    for (const i of c.images) {
      lines.push(`      { tag: ${quote(i.tag)}, dockerfile: ${quote(i.dockerfile)}${i.context === '.' ? '' : `, context: ${quote(i.context)}`}, env: ${quote(i.env)} },`)
    }
    lines.push('    ],')
    lines.push(`    upstream: { service: ${quote(c.upstream.service)}, port: ${c.upstream.port} },`)
    if (Object.keys(c.env).length) lines.push(`    env: { ${Object.entries(c.env).map(([k, v]) => `${k}: ${quote(v)}`).join(', ')} },`)
    lines.push('  }),')
  } else {
    helpers.add('pm2')
    const avoid = facts.server?.busyPorts ?? []
    lines.push(`  runtime: pm2(${avoid.length ? `{ avoid: [${avoid.join(', ')}] }` : ''}),${avoid.length ? '   // ports already taken on this server' : ''}`)
  }

  if (answers.proxy === 'caddy') {
    helpers.add('caddy')
    // One certificate per tenant host, issued only for hosts the app vouches for.
    lines.push(answers.tenants === 'subdomain'
      ? `  proxy: caddy({ onDemandTls: { ask: '/tls/allowed' } }),   // GET /tls/allowed?domain=<host> must answer 200 for the app's hosts only`
      : '  proxy: caddy(),')
  }
  if (answers.proxy === 'apache') {
    helpers.add('apache')
    const vhosts = facts.server?.vhosts ?? []
    if (vhosts.length) lines.push(`  proxy: apache({ managed: false, vhosts: [${vhosts.map(quote).join(', ')}] }),   // the vhosts this server already has`)
    else lines.push('  proxy: apache(),')
  }
  lines.push(`  health: { path: ${quote(facts.health)} },`)

  const header = [
    '/**',
    ` * Deploy of ${facts.app} with @basaltkit/deploy — written by \`basalt-deploy init\`.`,
    ' * Holds no secrets. What is true of one server only goes in /etc/basalt/<app>.json.',
    ' *',
    ' *   node node_modules/@basaltkit/deploy/dist/bin.js check   # this file, without a server',
    ' *   node node_modules/@basaltkit/deploy/dist/bin.js plan    # on the server: what run would do',
    ' *   node node_modules/@basaltkit/deploy/dist/bin.js run',
    ' */',
  ]
  const order = ['apache', 'ask', 'caddy', 'compose', 'defineDeploy', 'dockerInfra', 'pm2', 'secret']
  const imports = order.filter((h) => helpers.has(h))
  return [
    ...header,
    ...(facts.env ? [`import type { ${facts.env.exportName} } from './${facts.env.schema.replace(/\.ts$/, '.js')}'`] : []),
    `import { ${imports.join(', ')} } from '@basaltkit/deploy'`,
    '',
    `export default defineDeploy${facts.env ? `<typeof ${facts.env.exportName}>` : ''}({`,
    ...lines,
    '})',
    '',
  ].join('\n')
}

function block(name: string, entries: string[]): string[] {
  if (entries.join(', ').length < 70) return [`    ${name}: { ${entries.join(', ')} },`]
  return [`    ${name}: {`, ...entries.map((e) => `      ${e},`), '    },']
}

/** `GLOBEX_SMTP_URL` → `SMTP URL`: the prompt the operator sees once. */
function label(key: string, app: string): string {
  const prefix = `${app.toUpperCase().replace(/-/g, '_')}_`
  return (key.startsWith(prefix) ? key.slice(prefix.length) : key).replace(/_/g, ' ')
}

function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

// ── the command ────────────────────────────────────────────────────────────

export async function init(host: Host, dir: string, flags: Map<string, string>, switches: Set<string>): Promise<number> {
  const file = flags.get('config') ?? 'deploy.config.ts'
  const path = `${dir}/${file}`
  if ((await host.stat(path)) && !switches.has('force')) {
    host.out.error(`${file} already exists — init never overwrites it (--force to replace it)`)
    return 1
  }
  const answer = async (key: string, question: string, fallback?: string): Promise<string | undefined> => {
    const given = flags.get(key)
    if (given !== undefined) return given
    if (!host.interactive()) return fallback
    const typed = (await host.prompt(`${question}${fallback ? ` [${fallback}]` : ''}: `, { secret: false }))?.trim()
    return typed || fallback
  }
  const domain = await answer('domain', 'Domain the app answers on (e.g. acme.example.ao)')
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    host.out.error(`--domain=<host> is required${domain ? `: "${domain}" is not a host name` : ''}`)
    return 1
  }
  const tenants = await answer('tenants', 'Tenants on subdomains (<id>.domain)? subdomain | none', 'none')
  if (tenants !== 'subdomain' && tenants !== 'none') {
    host.out.error('--tenants is subdomain or none')
    return 1
  }
  const branch = (await answer('branch', 'Branch deployed', 'main')) ?? 'main'
  const proxy = (await answer('proxy', 'Proxy on this server: apache | caddy | none', 'apache')) ?? 'apache'
  if (proxy !== 'apache' && proxy !== 'caddy' && proxy !== 'none') {
    host.out.error('--proxy is apache, caddy or none')
    return 1
  }

  host.out.step('init')
  const facts = await detectProject(host, dir, { server: switches.has('server') ? domain : undefined })
  for (const line of describeFacts(facts)) host.out.info(line)
  const source = renderConfig(facts, { domain, tenants, branch, proxy })
  await host.writeFile(path, source, 0o644)
  host.out.ok(`${file} written — commit it`)
  return 0
}

export function describeFacts(facts: ProjectFacts): string[] {
  const lines = [`app: ${facts.app}`]
  if (facts.env) {
    const secrets = facts.env.keys.filter((k) => k.secret).length
    lines.push(`env: ${facts.env.schema} — ${facts.env.keys.length} key(s), ${secrets} secret(s)`)
  } else lines.push('env: no src/env.ts — the config is not typed by the app\'s env')
  if (facts.prisma.length) lines.push(`prisma: ${facts.prisma.join(', ')}${facts.tenants ? ' (schema per tenant)' : ''}`)
  if (facts.migrateScript) lines.push(`migrate: pnpm ${facts.migrateScript}`)
  if (facts.web) lines.push(`web: ${facts.web}/`)
  if (facts.compose) lines.push(`runtime: compose (${facts.compose.file}: ${facts.compose.images.map((i) => i.tag).join(', ')})`)
  else lines.push('runtime: pm2 (no production compose file)')
  if (facts.server) lines.push(`server: ${facts.server.vhosts.length ? `vhosts ${facts.server.vhosts.join(', ')}` : 'no vhost for this domain'}; ports taken: ${facts.server.busyPorts.join(', ') || 'none'}`)
  return lines
}
