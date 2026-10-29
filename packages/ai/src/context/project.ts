import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Reads project files relative to a root. Injectable so the whole detection layer
 * is unit-testable with an in-memory map (no disk).
 */
export interface ProjectReader {
  read(relPath: string): string | null
  exists(relPath: string): boolean
  /**
   * Every file under `relDir`, recursively, as paths relative to the root.
   * Optional: a reader without it simply skips the checks that scan the
   * project's route files.
   */
  list?(relDir: string): string[]
}

/** Upper bound on the files a route scan reads — a doctor run stays cheap on a large repo. */
const MAX_SCANNED_FILES = 2000

/** Default reader backed by the filesystem. */
export function nodeReader(root: string): ProjectReader {
  return {
    read(relPath) {
      try {
        return readFileSync(join(root, relPath), 'utf8')
      } catch {
        return null
      }
    },
    exists: (relPath) => existsSync(join(root, relPath)),
    list(relDir) {
      const out: string[] = []
      const walk = (dir: string): void => {
        let entries
        try {
          entries = readdirSync(join(root, dir), { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          if (out.length >= MAX_SCANNED_FILES) return
          if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
          const rel = `${dir}/${entry.name}`
          if (entry.isDirectory()) walk(rel)
          else if (entry.isFile()) out.push(rel)
        }
      }
      walk(trimTrailingSlashes(relDir))
      return out
    },
  }
}

/** Drops trailing `/` characters in linear time (a `/\/+$/` regex backtracks on long runs of `/`). */
function trimTrailingSlashes(path: string): string {
  let end = path.length
  while (end > 0 && path.charCodeAt(end - 1) === 47) end--
  return path.slice(0, end)
}

/** In-memory reader for tests: keys are relative paths. */
export function memoryReader(files: Record<string, string>): ProjectReader {
  return {
    read: (relPath) => files[relPath] ?? null,
    // A folder exists when a file sits under it, as on disk.
    exists: (relPath) => relPath in files || Object.keys(files).some((path) => path.startsWith(`${relPath}/`)),
    list: (relDir) => {
      const prefix = `${trimTrailingSlashes(relDir)}/`
      return Object.keys(files).filter((path) => path.startsWith(prefix))
    },
  }
}

/** Which capabilities the app actually wires (from its plugin list), not just installs. */
export interface DetectedStack {
  http: 'fastify' | null
  orm: 'prisma' | null
  database: 'postgresql' | 'mysql' | 'sqlite' | null
  tenancy: boolean
  auth: boolean
  rbac: boolean
  subscriptions: boolean
  payments: boolean
  storage: boolean
  queue: boolean
  search: boolean
  audit: boolean
  events: boolean
  scheduler: boolean
  logger: boolean
  ai: boolean
}

/** A model column as declared: `type` keeps Prisma's spelling minus `?`/`[]`. */
export interface PrismaColumn {
  name: string
  type: string
  optional: boolean
  list: boolean
}

export interface PrismaModel {
  name: string
  fields: string[]
  /** The same fields with their types, so a resource can be generated for an existing model. */
  columns?: PrismaColumn[]
  /** True when the model carries a `tenantId` column (tenant-scoped). */
  tenantScoped: boolean
  /** The `@@map("…")` table name, when the model declares one. */
  table?: string
}

export interface PrismaInfo {
  provider: DetectedStack['database']
  models: PrismaModel[]
}

export interface AppFileInfo {
  path: string
  /** Plugin factories detected in the `plugins:` array, e.g. `'fastifyPlugin'`. */
  plugins: string[]
  /** `fastifyPlugin({ fastify: { logger … } })` present. */
  fastifyLoggerConfigured: boolean
  /** In-memory (non-durable) sources still wired, e.g. `MemoryTenantSource`. */
  memorySources: string[]
  /** Every `<name>Plugin(` factory call in the app file (unfiltered by capability). */
  pluginCalls: string[]
  /** Plugins called without the option that takes a durable store. */
  defaultMemoryStores: DefaultMemoryStore[]
}

export interface ServerFileInfo {
  path: string
  /** Calls `.$connect()` somewhere in bootstrap (fail-loud DB check). */
  connectsAtBoot: boolean
  /** Calls `.listen(` (actually starts a server). */
  startsServer: boolean
}

export interface EnvFileInfo {
  path: string
  /** Default value baked into `APP_SECRET`, if any. */
  appSecretDefault: string | null
  /** Default value baked into `REDIS_URL`, if any. */
  redisUrlDefault: string | null
}

/**
 * A route declared central (`meta.tenant: false`) whose permission names the
 * platform plane (`can: 'platform:…'`), without `tenant: 'never'`. It still
 * runs on a tenant host, against that tenant's storage.
 */
export interface CentralPlatformRouteHint {
  path: string
  /** 1-based line of the `meta` object. */
  line: number
}

/** A spot in a source file a rule points at. */
export interface SourceHint {
  path: string
  /** 1-based line. */
  line: number
}

/** Findings from scanning the app's own source files under `src/`. */
export interface SourceHints {
  /** `ctx()`, `tryCtx()` or `db()` called while a module loads, outside any function. */
  moduleScopeContext: SourceHint[]
  /** `new HookBus()`: a bus of its own, which the app's events never reach. */
  detachedHookBus: SourceHint[]
  /** Imports from `zod/v3`. */
  zodV3Imports: SourceHint[]
}

/** What the project's Prisma migrations create. */
export interface MigrationsInfo {
  /** The migrations folder, relative to the root. */
  path: string
  /** `migration.sql` files found. */
  files: number
  /** Tables those files create (or rename to), lower-cased, schema prefix dropped. */
  tables: string[]
}

/** The reference schema an installed `@basaltkit/*-prisma` package ships. */
export interface FrameworkSchema {
  package: string
  models: PrismaModel[]
}

/** A plugin left on the in-memory store it falls back to. */
export interface DefaultMemoryStore {
  plugin: string
  /** The option that takes the durable store. */
  option: string
  /** The package that provides one. */
  durable: string
}

export interface ProjectContext {
  root: string
  /**
   * Platform routes that do not refuse a tenant. Absent when the reader cannot
   * list files.
   */
  centralPlatformRoutes?: CentralPlatformRouteHint[]
  /** All `@basaltkit/*` packages found in package.json deps. */
  installed: string[]
  stack: DetectedStack
  prisma: PrismaInfo | null
  app: AppFileInfo | null
  server: ServerFileInfo | null
  env: EnvFileInfo | null
  /**
   * The Prisma migrations: null when there is no migrations folder (the
   * project uses `db push`, or has no Prisma). Absent when the reader cannot
   * list files.
   */
  migrations?: MigrationsInfo | null
  /** Reference schemas of the installed `@basaltkit/*-prisma` packages. */
  frameworkSchemas?: FrameworkSchema[]
  /** Scan of the app's own source files. Absent when the reader cannot list files. */
  sourceHints?: SourceHints
}

const APP_CANDIDATES = ['src/app.ts', 'src/app.js', 'app.ts']
const SERVER_CANDIDATES = ['src/server.ts', 'src/server.js', 'src/main.ts', 'server.ts']
const ENV_CANDIDATES = ['src/env.ts', 'src/env.js', 'src/config/env.ts']
const SCHEMA_CANDIDATES = ['prisma/schema.prisma', 'schema.prisma']

/** Maps a plugin factory name → its `DetectedStack` boolean key. */
const PLUGIN_TO_CAPABILITY: Record<string, keyof DetectedStack> = {
  fastifyPlugin: 'http',
  prismaPlugin: 'orm',
  tenancyPlugin: 'tenancy',
  authPlugin: 'auth',
  permissionsPlugin: 'rbac',
  subscriptionsPlugin: 'subscriptions',
  paymentsPlugin: 'payments',
  storagePlugin: 'storage',
  // Every queue backend ships its own plugin wrapping `queuePlugin`, and an app
  // that picked one never names the core factory. Detecting only `queuePlugin`
  // would report "no queue" for the most common setups.
  queuePlugin: 'queue',
  bullmqQueuePlugin: 'queue',
  rabbitmqQueuePlugin: 'queue',
  sqsQueuePlugin: 'queue',
  kafkaQueuePlugin: 'queue',
  searchPlugin: 'search',
  auditPlugin: 'audit',
  eventsPlugin: 'events',
  schedulerPlugin: 'scheduler',
  loggerPlugin: 'logger',
}

const PLUGIN_FACTORIES = Object.keys(PLUGIN_TO_CAPABILITY)

/** Detect the project's stack and key files. Pure over the injected reader. */
export function detectProject(root: string, reader: ProjectReader = nodeReader(root)): ProjectContext {
  const installed = detectInstalled(reader)
  const app = detectAppFile(reader)
  const server = detectServerFile(reader)
  const env = detectEnvFile(reader)
  const prisma = detectPrisma(reader)
  const stack = buildStack(installed, app, prisma)
  const centralPlatformRoutes = detectCentralPlatformRoutes(reader)
  const migrations = detectMigrations(reader)
  const sourceHints = detectSourceHints(reader)
  return {
    root,
    installed,
    stack,
    prisma,
    app,
    server,
    env,
    frameworkSchemas: detectFrameworkSchemas(reader, installed, prisma?.provider ?? null),
    ...(centralPlatformRoutes ? { centralPlatformRoutes } : {}),
    ...(migrations !== undefined ? { migrations } : {}),
    ...(sourceHints ? { sourceHints } : {}),
  }
}

/** The app's own source files: `src/**` scripts, without tests and declarations. */
function sourceFiles(reader: ProjectReader): string[] | undefined {
  if (!reader.list) return undefined
  return reader
    .list('src')
    .filter((path) => /\.[cm]?[jt]s$/.test(path) && !/\.d\.ts$|\.(test|spec)\.[cm]?[jt]s$/.test(path))
    .slice(0, MAX_SCANNED_FILES)
}

const MIGRATIONS_DIR = 'prisma/migrations'

/**
 * Tables the migrations create. Reads `CREATE TABLE` (and `RENAME TO`) from
 * every `migration.sql`: what `prisma migrate deploy` builds in production.
 */
function detectMigrations(reader: ProjectReader): MigrationsInfo | null | undefined {
  if (!reader.list) return undefined
  if (!reader.exists(MIGRATIONS_DIR)) return null
  const files = reader.list(MIGRATIONS_DIR).filter((path) => path.endsWith('/migration.sql'))
  const tables = new Set<string>()
  const name = String.raw`(?:[\x60"\[]?\w+[\x60"\]]?\s*\.\s*)?[\x60"\[]?(\w+)[\x60"\]]?`
  const create = new RegExp(String.raw`\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?` + name, 'gi')
  const rename = new RegExp(String.raw`\bRENAME\s+TO\s+` + name, 'gi')
  for (const path of files) {
    const sql = reader.read(path) ?? ''
    for (const match of sql.matchAll(create)) if (match[1]) tables.add(match[1].toLowerCase())
    for (const match of sql.matchAll(rename)) if (match[1]) tables.add(match[1].toLowerCase())
  }
  return { path: MIGRATIONS_DIR, files: files.length, tables: [...tables].sort() }
}

/** The reference schema of every installed `@basaltkit/*-prisma` package, in the app's dialect. */
function detectFrameworkSchemas(
  reader: ProjectReader,
  installed: string[],
  provider: DetectedStack['database'],
): FrameworkSchema[] {
  const schemas: FrameworkSchema[] = []
  for (const pkg of installed.filter((name) => name.endsWith('-prisma'))) {
    const dir = `node_modules/${pkg}/prisma`
    const schema =
      (provider === 'mysql' ? reader.read(`${dir}/schema.mysql.prisma`) : null) ?? reader.read(`${dir}/schema.prisma`)
    if (schema) schemas.push({ package: pkg, models: parseModels(schema) })
  }
  return schemas
}

/** The local names under which a module imports `wanted` from `source` (`{ db as getDb }` → getDb). */
function localNames(content: string, source: string, wanted: string[]): string[] {
  const names: string[] = []
  const from = new RegExp(String.raw`import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]${source.replace('/', '\\/')}['"]`, 'g')
  for (const match of content.matchAll(from)) {
    for (const part of (match[1] ?? '').split(',')) {
      const [imported, local] = part.trim().split(/\s+as\s+/).map((name) => name.trim())
      if (imported && wanted.includes(imported)) names.push(local ?? imported)
    }
  }
  return names
}

/**
 * Scans `src/` for three mistakes a regex can see without false alarms:
 * a request-context call in a module's top-level `const`, a HookBus of its
 * own, and zod/v3 imports. Matches must start in code (comments and string
 * text are blanked), as for the route scan.
 */
function detectSourceHints(reader: ProjectReader): SourceHints | undefined {
  const files = sourceFiles(reader)
  if (!files) return undefined
  const hints: SourceHints = { moduleScopeContext: [], detachedHookBus: [], zodV3Imports: [] }
  for (const path of files) {
    const content = reader.read(path)
    if (!content) continue
    const code = codeOnly(content)
    const lineOf = (index: number): number => content.slice(0, index).split('\n').length

    const callees = [
      ...localNames(content, '@basaltkit/core', ['ctx', 'tryCtx']),
      ...localNames(content, '@basaltkit/prisma', ['db']),
    ]
    if (callees.length > 0) {
      const call = new RegExp(String.raw`\b(?:` + callees.join('|') + String.raw`)\s*(?:<[^<>()]*>)?\s*\(\s*\)`)
      let depth = 0
      let offset = 0
      for (const line of code.split('\n')) {
        // A top-level `const x = …` whose initializer, on that line, calls
        // the context before any function begins: it runs at import time.
        const declaration = depth === 0
          ? /^(?:export\s+)?(?:const|let|var)\s+[\w$]+(?:\s*:[^=]+)?\s*=(?![=>])(.*)$/.exec(line)
          : null
        if (declaration) {
          const initializer = declaration[1] ?? ''
          const at = initializer.search(call)
          const fn = initializer.search(/=>|\bfunction\b/)
          if (at !== -1 && (fn === -1 || at < fn)) hints.moduleScopeContext.push({ path, line: lineOf(offset) })
        }
        for (const ch of line) {
          if (ch === '{') depth++
          else if (ch === '}') depth = Math.max(0, depth - 1)
        }
        offset += line.length + 1
      }
    }

    for (const match of code.matchAll(/\bnew\s+HookBus\s*\(/g)) {
      hints.detachedHookBus.push({ path, line: lineOf(match.index ?? 0) })
    }
    for (const match of content.matchAll(/\b(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]zod\/v3['"]/g)) {
      const index = match.index ?? 0
      if (!/^(from|import|require)/.test(code.slice(index, index + 7))) continue
      hints.zodV3Imports.push({ path, line: lineOf(index) })
    }
  }
  return hints
}

/**
 * Finds `meta: { … }` literals with `tenant: false` and a `can` naming
 * `platform:…`. A regex over flat object literals, not a parser: it sees
 * `meta: { tenant: false, can: 'platform:plans' }` written inline, which is
 * how routes are declared; meta built elsewhere and spread in goes unseen.
 */
function detectCentralPlatformRoutes(reader: ProjectReader): CentralPlatformRouteHint[] | undefined {
  if (!reader.list) return undefined
  const files = reader
    .list('src')
    .filter((path) => /\.[cm]?[jt]s$/.test(path) && !/\.d\.ts$|\.(test|spec)\.[cm]?[jt]s$/.test(path))
    .slice(0, MAX_SCANNED_FILES)
  const hits: CentralPlatformRouteHint[] = []
  for (const path of files) {
    const content = reader.read(path)
    if (!content || !content.includes('platform:')) continue
    // Same length as the source, comments and string text blanked: a match
    // must start in code, so a commented-out route never counts.
    const code = codeOnly(content)
    for (const match of content.matchAll(/\bmeta\s*:\s*\{([^{}]*)\}/g)) {
      const index = match.index ?? 0
      if (code.slice(index, index + 4) !== 'meta') continue
      const body = match[1] ?? ''
      if (!/\btenant\s*:\s*false\b/.test(body)) continue
      if (!/\bcan\s*:\s*\[?\s*['"`]platform:/.test(body)) continue
      hits.push({ path, line: content.slice(0, index).split('\n').length })
    }
  }
  return hits
}

function detectInstalled(reader: ProjectReader): string[] {
  const raw = reader.read('package.json')
  if (!raw) return []
  try {
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    return Object.keys(deps)
      .filter((name) => name.startsWith('@basaltkit/'))
      .sort()
  } catch {
    return []
  }
}

function firstExisting(reader: ProjectReader, candidates: string[]): { path: string; content: string } | null {
  for (const path of candidates) {
    const content = reader.read(path)
    if (content !== null) return { path, content }
  }
  return null
}

function detectAppFile(reader: ProjectReader): AppFileInfo | null {
  const raw = firstExisting(reader, APP_CANDIDATES)
  if (!raw) return null
  // Match against CODE only: a commented-out `// tenantMembershipPlugin()` (or the
  // name inside a string) must never count as a registration — that silenced
  // security rules for exactly the apps that had disabled the guard.
  const found = { path: raw.path, content: codeOnly(raw.content) }
  const plugins = PLUGIN_FACTORIES.filter((factory) =>
    new RegExp(`\\b${factory}\\s*\\(`).test(found.content),
  )
  const fastifyLoggerConfigured = /fastify\s*:\s*\{[^}]*\blogger\b/.test(found.content)
  const memorySources = [
    'MemoryTenantSource',
    'MemoryUserSource',
    // Security-critical in-memory stores: auth/authorization/domain state that
    // must survive restarts and be shared across instances in production.
    'MemoryPasskeyStore',
    'MemoryWebAuthnChallengeStore',
    'MemoryAccessStore',
    'MemoryDomainStore',
  ].filter((source) =>
    found.content.includes(source),
  )
  const pluginCalls = [
    ...new Set(Array.from(found.content.matchAll(/\b([A-Za-z][A-Za-z0-9]*Plugin)\s*\(/g), (m) => m[1] as string)),
  ]
  const defaultMemoryStores = MEMORY_DEFAULT_PLUGINS.filter((spec) =>
    pluginCallArguments(found.content, spec.plugin).some((args) => !takesOption(args, spec.option)),
  )
  return { path: found.path, plugins, fastifyLoggerConfigured, memorySources, pluginCalls, defaultMemoryStores }
}

/**
 * Plugins that fall back to an in-memory store when the option is left out:
 * fine in a test, lost on every restart and not shared between instances.
 */
const MEMORY_DEFAULT_PLUGINS: DefaultMemoryStore[] = [
  { plugin: 'commentsPlugin', option: 'store', durable: '@basaltkit/comments-prisma' },
  { plugin: 'activityPlugin', option: 'store', durable: '@basaltkit/activity-prisma' },
  { plugin: 'auditPlugin', option: 'store', durable: '@basaltkit/audit-prisma' },
  { plugin: 'filesPlugin', option: 'store', durable: '@basaltkit/files-prisma' },
  { plugin: 'notificationsPlugin', option: 'inApp', durable: '@basaltkit/notifications-prisma' },
  { plugin: 'teamsPlugin', option: 'memberships', durable: '@basaltkit/teams-prisma' },
  { plugin: 'webhooksPlugin', option: 'store', durable: '@basaltkit/webhooks-prisma' },
  { plugin: 'outboxPlugin', option: 'store', durable: '@basaltkit/events-prisma' },
]

/** The argument text of every `<plugin>(…)` call in code, parentheses balanced. */
function pluginCallArguments(code: string, plugin: string): string[] {
  const out: string[] = []
  for (const match of code.matchAll(new RegExp(String.raw`\b${plugin}\s*\(`, 'g'))) {
    let depth = 1
    let i = (match.index ?? 0) + match[0].length
    const start = i
    for (; i < code.length && depth > 0; i++) {
      if (code[i] === '(') depth++
      else if (code[i] === ')') depth--
    }
    out.push(code.slice(start, i - 1).trim())
  }
  return out
}

/**
 * Whether the arguments pass `option`. Anything that is not an inline object
 * (a variable, a spread) may carry it, so it counts as passed: the rule only
 * speaks when it can see the option is missing.
 */
function takesOption(args: string, option: string): boolean {
  if (args === '') return false
  if (!args.startsWith('{') || args.includes('...')) return true
  return new RegExp(String.raw`[{,\s]${option}\s*[:,}]|[{,\s]${option}\s*$`).test(args)
}

/**
 * The source with comments removed and string/template-literal TEXT blanked
 * (quotes and `${…}` expressions are kept, newlines preserved), so detection
 * regexes only ever see code. A lexer-lite, not a parser: regex literals are
 * not special-cased, which is fine for app composition files.
 */
function codeOnly(source: string): string {
  let out = ''
  let i = 0
  // Stack of open template literals; each entry is the `${` brace depth inside it.
  const templates: number[] = []
  const blank = (ch: string): string => (ch === '\n' ? '\n' : ' ')
  const inTemplateText = (): boolean => templates.length > 0 && templates[templates.length - 1] === -1
  while (i < source.length) {
    const ch = source[i] as string
    const next = source[i + 1]
    if (inTemplateText()) {
      if (ch === '\\') {
        out += '  '
        i += 2
      } else if (ch === '`') {
        templates.pop()
        out += ch
        i++
      } else if (ch === '$' && next === '{') {
        templates[templates.length - 1] = 0
        out += '${'
        i += 2
      } else {
        out += blank(ch)
        i++
      }
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' '
        i++
      }
    } else if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      for (; i < stop; i++) out += blank(source[i] as string)
    } else if (ch === "'" || ch === '"') {
      out += ch
      i++
      while (i < source.length && source[i] !== ch && source[i] !== '\n') {
        if (source[i] === '\\') {
          out += ' '
          i++
        }
        if (i < source.length) out += blank(source[i] as string)
        i++
      }
      if (i < source.length) {
        out += source[i]
        i++
      }
    } else if (ch === '`') {
      templates.push(-1)
      out += ch
      i++
    } else {
      if (templates.length > 0) {
        const top = templates.length - 1
        if (ch === '{') templates[top] = (templates[top] as number) + 1
        else if (ch === '}') {
          if (templates[top] === 0) templates[top] = -1
          else templates[top] = (templates[top] as number) - 1
        }
      }
      out += ch
      i++
    }
  }
  return out
}

function detectServerFile(reader: ProjectReader): ServerFileInfo | null {
  const found = firstExisting(reader, SERVER_CANDIDATES)
  if (!found) return null
  return {
    path: found.path,
    connectsAtBoot: /\.\$connect\s*\(/.test(found.content),
    startsServer: /\.listen\s*\(/.test(found.content),
  }
}

function detectEnvFile(reader: ProjectReader): EnvFileInfo | null {
  const found = firstExisting(reader, ENV_CANDIDATES)
  if (!found) return null
  return {
    path: found.path,
    appSecretDefault: captureDefault(found.content, 'APP_SECRET'),
    redisUrlDefault: captureDefault(found.content, 'REDIS_URL'),
  }
}

/** Pull the literal from `KEY: z.string()….default('literal')`. */
function captureDefault(content: string, key: string): string | null {
  const match = new RegExp(`${key}\\s*:[^\\n]*?\\.default\\(\\s*['"\`]([^'"\`]*)['"\`]`).exec(content)
  return match ? (match[1] ?? null) : null
}

function detectPrisma(reader: ProjectReader): PrismaInfo | null {
  const found = firstExisting(reader, SCHEMA_CANDIDATES)
  if (!found) return null
  const providerMatch = /datasource\s+\w+\s*\{[^}]*provider\s*=\s*"(\w+)"/s.exec(found.content)
  const provider = normalizeProvider(providerMatch?.[1])
  const models = parseModels(found.content)
  return { provider, models }
}

function normalizeProvider(raw: string | undefined): DetectedStack['database'] {
  switch (raw) {
    case 'postgresql':
      return 'postgresql'
    case 'mysql':
      return 'mysql'
    case 'sqlite':
      return 'sqlite'
    default:
      return null
  }
}

function parseModels(schema: string): PrismaModel[] {
  const models: PrismaModel[] = []
  const modelRegex = /model\s+(\w+)\s*\{([^}]*)\}/gs
  // Comments go first: a `}` in one (`// { id, ...anything }`) would end the
  // model there, losing every field and the @@map after it.
  const source = stripComments(schema)
  let match: RegExpExecArray | null
  while ((match = modelRegex.exec(source)) !== null) {
    const name = match[1]
    const body = match[2]
    if (!name || body === undefined) continue
    const columns: PrismaColumn[] = []
    for (const line of body.split('\n')) {
      const [field, rawType] = line.trim().split(/\s+/)
      if (!field || field.startsWith('@') || field.startsWith('//')) continue
      const type = (rawType ?? '').replace(/[?[\]]/g, '')
      columns.push({ name: field, type, optional: rawType?.endsWith('?') === true, list: rawType?.endsWith('[]') === true })
    }
    const fields = columns.map((c) => c.name)
    const table = /@@map\(\s*"([^"]+)"\s*\)/.exec(body)?.[1]
    models.push({ name, fields, columns, tenantScoped: fields.includes('tenantId'), ...(table ? { table } : {}) })
  }
  return models
}

/** Drops `//` comments — only at a line start or after whitespace, so `"postgres://…"` survives. */
function stripComments(schema: string): string {
  return schema.replace(/(^|\s)\/\/.*$/gm, '$1')
}

function buildStack(installed: string[], app: AppFileInfo | null, prisma: PrismaInfo | null): DetectedStack {
  const stack: DetectedStack = {
    http: null,
    orm: null,
    database: prisma?.provider ?? null,
    tenancy: false,
    auth: false,
    rbac: false,
    subscriptions: false,
    payments: false,
    storage: false,
    queue: false,
    search: false,
    audit: false,
    events: false,
    scheduler: false,
    logger: false,
    ai: installed.includes('@basaltkit/ai'),
  }
  // Prefer the plugins actually wired in app.ts; fall back to installed packages.
  const enabled = new Set(app?.plugins ?? [])
  const flags = stack as unknown as Record<string, boolean | string | null>
  for (const [factory, capability] of Object.entries(PLUGIN_TO_CAPABILITY)) {
    if (!enabled.has(factory)) continue
    if (capability === 'http') stack.http = 'fastify'
    else if (capability === 'orm') stack.orm = 'prisma'
    else flags[capability] = true
  }
  if (!stack.http && installed.includes('@basaltkit/fastify')) stack.http = 'fastify'
  if (!stack.orm && installed.includes('@basaltkit/prisma')) stack.orm = 'prisma'
  if (!stack.rbac && installed.includes('@basaltkit/permissions')) stack.rbac = true
  return stack
}
