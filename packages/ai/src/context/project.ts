import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Reads project files relative to a root. Injectable so the whole detection layer
 * is unit-testable with an in-memory map (no disk).
 */
export interface ProjectReader {
  read(relPath: string): string | null
  exists(relPath: string): boolean
}

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
  }
}

/** In-memory reader for tests: keys are relative paths. */
export function memoryReader(files: Record<string, string>): ProjectReader {
  return {
    read: (relPath) => files[relPath] ?? null,
    exists: (relPath) => relPath in files,
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

export interface PrismaModel {
  name: string
  fields: string[]
  /** True when the model carries a `tenantId` column (tenant-scoped). */
  tenantScoped: boolean
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

export interface ProjectContext {
  root: string
  /** All `@basaltkit/*` packages found in package.json deps. */
  installed: string[]
  stack: DetectedStack
  prisma: PrismaInfo | null
  app: AppFileInfo | null
  server: ServerFileInfo | null
  env: EnvFileInfo | null
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
  queuePlugin: 'queue',
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
  return { root, installed, stack, prisma, app, server, env }
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
  const found = firstExisting(reader, APP_CANDIDATES)
  if (!found) return null
  const plugins = PLUGIN_FACTORIES.filter((factory) =>
    new RegExp(`\\b${factory}\\s*\\(`).test(found.content),
  )
  const fastifyLoggerConfigured = /fastify\s*:\s*\{[^}]*\blogger\b/.test(found.content)
  const memorySources = ['MemoryTenantSource', 'MemoryUserSource'].filter((source) =>
    found.content.includes(source),
  )
  return { path: found.path, plugins, fastifyLoggerConfigured, memorySources }
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
  let match: RegExpExecArray | null
  while ((match = modelRegex.exec(schema)) !== null) {
    const name = match[1]
    const body = match[2]
    if (!name || body === undefined) continue
    const fields = body
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((token): token is string => !!token && !token.startsWith('@') && !token.startsWith('//'))
    models.push({ name, fields, tenantScoped: fields.includes('tenantId') })
  }
  return models
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
