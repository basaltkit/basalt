import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { binStatus } from '../bin-template.js'
import { devEntryStatus } from '../dev-entry.js'
import { alwaysLatest, lookupLatestVersions, type ResolveLatestOptions } from '../latest-versions.js'
import { PRODUCTION_ENTRY } from '../stubs.js'
import { envPrefix } from '../templates.js'
import { allDependencies, type ProjectContext } from './context.js'
import { ownVersion } from './manifest.js'
import type { PackageJson } from './package-json.js'
import { LEGACY_PRISMA_OUTPUT, RUNS_TSX } from './production.js'
import { legacySeedScriptFix } from './seed-script.js'
import { compareVersions, parseSimpleRange, parseVersion, satisfies } from './semver.js'
import type { Colors } from './term.js'

/**
 * `create-basalt doctor`: a read-only health check of an app — nothing is
 * written, nothing is installed. Errors make the exit code non-zero; warnings
 * and notes do not.
 */

export type Level = 'ok' | 'info' | 'warn' | 'error'

export interface DoctorFinding {
  level: Level
  /** Short area label: node, pm, deps, env, prisma, mcp, tooling, build. */
  area: string
  message: string
}

export interface DoctorOptions {
  /** Node version to check (default: the running one). */
  nodeVersion?: string
  env?: NodeJS.ProcessEnv
  /** Skip the registry ("behind latest" check). */
  offline?: boolean
  registry?: ResolveLatestOptions
  /** `<pm> --version` (injected; undefined when unavailable). */
  pmVersion?: string
}

/** Mirrors the placeholder check of `secret()` in @basaltkit/env (src/secret.ts). */
export const INSECURE_SECRET = /change.?me|changeme|placeholder|example|secret|password|default|test|xxxx+|0000+/i

/** The Node range every @basaltkit package declares. */
export const BASALT_NODE_RANGE = '>=22.5.0'

async function readJson(path: string): Promise<PackageJson | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as PackageJson
  } catch {
    return undefined
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** Installed version of `name` as the app resolves it (top-level node_modules). */
export async function installedVersion(dir: string, name: string): Promise<string | undefined> {
  const pkg = await readJson(join(dir, 'node_modules', ...name.split('/'), 'package.json'))
  return typeof pkg?.version === 'string' ? pkg.version : undefined
}

/**
 * Every installed version of each @basaltkit package: pnpm's virtual store
 * (`node_modules/.pnpm/@basaltkit+core@1.5.0…`) plus npm/yarn nesting one level deep.
 */
async function installedFrameworkVersions(dir: string): Promise<Map<string, Set<string>>> {
  const found = new Map<string, Set<string>>()
  const add = (name: string, version: string): void => {
    const set = found.get(name) ?? new Set<string>()
    set.add(version)
    found.set(name, set)
  }
  const store = await readdir(join(dir, 'node_modules', '.pnpm')).catch(() => [] as string[])
  for (const entry of store) {
    const match = /^@basaltkit\+([^@]+)@(\d+\.\d+\.\d+[^_]*)/.exec(entry)
    if (match) add(`@basaltkit/${match[1]}`, match[2] as string)
  }
  const scope = join(dir, 'node_modules', '@basaltkit')
  for (const entry of await readdir(scope).catch(() => [] as string[])) {
    const version = await installedVersion(dir, `@basaltkit/${entry}`)
    if (version) add(`@basaltkit/${entry}`, version)
    for (const nested of await readdir(join(scope, entry, 'node_modules', '@basaltkit')).catch(() => [] as string[])) {
      const pkg = await readJson(join(scope, entry, 'node_modules', '@basaltkit', nested, 'package.json'))
      if (typeof pkg?.version === 'string') add(`@basaltkit/${nested}`, pkg.version)
    }
  }
  return found
}

/** Parses a dotenv file (KEY=VALUE, optional quotes, # comments). */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    let value = (match[2] ?? '').trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    out[match[1] as string] = value
  }
  return out
}

/** The env prefix src/env.ts passes to defineEnv (`prefix: 'X'` or `prefix: { value: 'X' … }`). */
export function envPrefixOf(envTs: string | undefined, name: string): string | undefined {
  if (envTs === undefined) return envPrefix(name)
  const match = /prefix:\s*(?:\{\s*value:\s*)?['"]([A-Z0-9_]+)['"]/.exec(envTs)
  return match ? match[1] : /prefix:/.test(envTs) ? undefined : ''
}

/**
 * The variables src/env.ts requires: keys of the schema object passed to
 * `defineEnv` whose declaration has no `.default(`, `.optional(`, `.catch(` or
 * `.nullish(` (`secret()` is checked separately — it has a dev default).
 * A light scan, not a parser: comments and strings are skipped, nesting is
 * tracked. Undefined when there is no `defineEnv({ … })` to read.
 */
export function requiredEnvKeys(envTs: string | undefined): string[] | undefined {
  if (envTs === undefined) return undefined
  const call = envTs.indexOf('defineEnv(')
  const open = call < 0 ? -1 : envTs.indexOf('{', call)
  if (open < 0) return undefined
  const entries: { key: string; body: string }[] = []
  let depth = 0
  let current: { key: string; body: string } | undefined
  for (let i = open; i < envTs.length; i++) {
    const char = envTs[i] as string
    if (char === '/' && envTs[i + 1] === '/') {
      const end = envTs.indexOf('\n', i)
      i = end < 0 ? envTs.length : end - 1
      continue
    }
    if (char === '/' && envTs[i + 1] === '*') {
      const end = envTs.indexOf('*/', i + 2)
      i = end < 0 ? envTs.length : end + 1
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      let end = i + 1
      while (end < envTs.length && envTs[end] !== char) end += envTs[end] === '\\' ? 2 : 1
      if (current) current.body += envTs.slice(i, end + 1)
      i = end
      continue
    }
    if (char === '{' || char === '(' || char === '[') depth++
    else if (char === '}' || char === ')' || char === ']') {
      depth--
      if (depth === 0) break
    }
    if (depth === 1 && (char === ',' || char === '{')) {
      if (current) entries.push(current)
      current = undefined
      const start = skipTrivia(envTs, i + 1)
      const match = /^([A-Z][A-Z0-9_]*)\s*:/.exec(envTs.slice(start, start + 200))
      if (match) {
        current = { key: match[1] as string, body: '' }
        i = start + match[0].length - 1
      }
      continue
    }
    if (current) current.body += char
  }
  if (current) entries.push(current)
  return entries
    .filter(({ body }) => !/\.(default|optional|catch|nullish)\(|\bsecret\(/.test(body))
    .map(({ key }) => key)
}

export async function runDoctor(ctx: ProjectContext, options: DoctorOptions = {}): Promise<DoctorFinding[]> {
  const findings: DoctorFinding[] = []
  const push = (level: Level, area: string, message: string): void => {
    findings.push({ level, area, message })
  }
  const env = options.env ?? process.env
  const deps = allDependencies(ctx.packageJson)
  const { dir } = ctx

  // --- Node -----------------------------------------------------------------
  const node = options.nodeVersion ?? process.versions.node
  const engines = ctx.packageJson.engines?.['node']
  for (const [range, origin] of [
    ...(engines ? [[engines, 'package.json engines.node'] as const] : []),
    [BASALT_NODE_RANGE, 'Basalt'] as const,
  ]) {
    const ok = satisfies(node, range)
    if (ok === false) push('error', 'node', `Node ${node} does not satisfy ${range} (${origin}).`)
    else if (ok === true) push('ok', 'node', `Node ${node} satisfies ${range} (${origin}).`)
  }

  // --- Package manager --------------------------------------------------------
  push('ok', 'pm', `Package manager: ${ctx.pm}${options.pmVersion ? ` ${options.pmVersion}` : ''} (from ${ctx.pmSource}).`)
  if (ctx.lockfiles.length > 1) push('warn', 'pm', `Several lockfiles (${ctx.lockfiles.join(', ')}) — keep the one of ${ctx.pm}.`)
  if (ctx.lockfiles.length === 0) push('warn', 'pm', `No lockfile — run \`${ctx.pm} install\` and commit it.`)
  const declaredPm = ctx.packageJson.packageManager?.split('@')[0]
  const lockPm = ctx.lockfiles[0] ? ctx.lockfiles[0].split(/[-.]/)[0] : undefined
  if (declaredPm && lockPm && ctx.lockfiles.length === 1 && !ctx.lockfiles[0]?.startsWith(declaredPm) && !(declaredPm === 'npm' && lockPm === 'npm')) {
    push('warn', 'pm', `packageManager says ${declaredPm}, but the lockfile is ${ctx.lockfiles[0]}.`)
  }
  if (ctx.options.ui && ctx.pm !== 'pnpm') {
    push('error', 'pm', `web/ is a pnpm workspace member, but this project uses ${ctx.pm}.`)
  }

  // --- Dependencies -----------------------------------------------------------
  const installedRoot = existsSync(join(dir, 'node_modules'))
  if (!installedRoot) {
    push('error', 'deps', `Dependencies are not installed — run \`${ctx.pm} install\`.`)
  } else {
    const missing: string[] = []
    const outOfSync: string[] = []
    for (const [name, range] of Object.entries(deps)) {
      const version = await installedVersion(dir, name)
      if (version === undefined) {
        if (!(ctx.packageJson.optionalDependencies && name in ctx.packageJson.optionalDependencies)) missing.push(name)
        continue
      }
      if (satisfies(version, range) === false) outOfSync.push(`${name} (${version} installed, ${range} declared)`)
    }
    if (missing.length > 0) push('error', 'deps', `Not installed: ${missing.join(', ')} — run \`${ctx.pm} install\`.`)
    if (outOfSync.length > 0) push('error', 'deps', `Installed versions do not match package.json: ${outOfSync.join('; ')} — run \`${ctx.pm} install\`.`)

    const framework = await installedFrameworkVersions(dir)
    const duplicates = [...framework].filter(([, versions]) => versions.size > 1)
    for (const [name, versions] of duplicates) {
      push('warn', 'deps', `${name} is installed in ${versions.size} versions (${[...versions].sort().join(', ')}) — framework singletons (DI tokens, context) may not line up; align the ranges (\`basalt update\`).`)
    }
    let peerProblems = 0
    for (const name of Object.keys(deps).filter((dep) => dep.startsWith('@basaltkit/'))) {
      const pkg = await readJson(join(dir, 'node_modules', ...name.split('/'), 'package.json'))
      const optional = (pkg?.['peerDependenciesMeta'] ?? {}) as Record<string, { optional?: boolean }>
      for (const [peer, range] of Object.entries(pkg?.peerDependencies ?? {})) {
        const version = await installedVersion(dir, peer)
        if (version === undefined) {
          if (!optional[peer]?.optional && peer.startsWith('@basaltkit/')) {
            peerProblems++
            push('warn', 'deps', `${name} expects ${peer} ${range}, which is not installed.`)
          }
          continue
        }
        if (satisfies(version, range) === false) {
          peerProblems++
          push('error', 'deps', `${name} expects ${peer} ${range}, but ${version} is installed.`)
        }
      }
    }
    if (missing.length === 0 && outOfSync.length === 0 && duplicates.length === 0 && peerProblems === 0) {
      push('ok', 'deps', 'Installed dependencies match package.json; @basaltkit peer ranges are satisfied.')
    }
  }
  for (const name of ['@basaltkit/ai-mcp', '@basaltkit/ai', '@basaltkit/generator', 'create-basalt']) {
    if (ctx.packageJson.dependencies?.[name] !== undefined) {
      push('warn', 'deps', `${name} is a runtime dependency — it is dev tooling; move it to devDependencies.`)
    }
  }

  // --- Behind latest ----------------------------------------------------------
  if (!options.offline) {
    const framework = Object.entries(deps).filter(([name]) => alwaysLatest(name))
    const { results } = await lookupLatestVersions(
      framework.map(([name]) => name),
      () => false,
      options.registry ?? {},
    )
    if (framework.length > 0 && framework.every(([name]) => results.get(name)?.latest === undefined)) {
      push('info', 'updates', 'Registry unreachable — skipped the "behind latest" check.')
    } else {
      const behind = framework.filter(([name, range]) => {
        const latest = parseVersion(results.get(name)?.latest ?? '')
        const floor = parseSimpleRange(range)
        return latest !== undefined && floor !== undefined && compareVersions(latest, floor.parsed) > 0
      })
      if (behind.length > 0) {
        push(
          'warn',
          'updates',
          `${behind.length} framework package(s) behind latest: ${behind
            .map(([name, range]) => `${name} ${range} → ${results.get(name)?.latest}`)
            .join(', ')} — run \`basalt update\` (or npx create-basalt@latest update).`,
        )
      } else if (framework.length > 0) push('ok', 'updates', 'Framework packages are on their latest versions.')
    }
  }

  // --- Environment ------------------------------------------------------------
  const envTs = await readText(join(dir, 'src', 'env.ts'))
  const dotenvText = await readText(join(dir, '.env'))
  const dotenv = dotenvText ? parseDotenv(dotenvText) : {}
  const exampleText = await readText(join(dir, '.env.example'))
  const example = exampleText ? parseDotenv(exampleText) : {}
  if (dotenvText === undefined && exampleText !== undefined) {
    push('warn', 'env', 'No .env — `dev` and `basalt` load it for development: `cp .env.example .env` (or export the variables).')
  }
  const prefix = envPrefixOf(envTs, ctx.options.name)
  const lookup = (name: string): { value: string; from: string } | undefined => {
    const names = prefix ? [`${prefix}_${name}`, name] : [name]
    for (const key of names) {
      if (env[key] !== undefined && env[key] !== '') return { value: env[key] as string, from: `$${key}` }
    }
    for (const key of names) {
      if (dotenv[key] !== undefined && dotenv[key] !== '') return { value: dotenv[key] as string, from: `.env ${key}` }
    }
    return undefined
  }
  if (ctx.options.auth) {
    const declared = envTs ? /APP_SECRET:\s*secret\(\{[^}]*minLength:\s*(\d+)/.exec(envTs) : null
    const minLength = declared ? Number(declared[1]) : 32
    const secret = lookup('APP_SECRET')
    const label = prefix ? `${prefix}_APP_SECRET` : 'APP_SECRET'
    if (!secret) {
      push('warn', 'env', `${label} is not set — fine for \`dev\` (development default), required by \`start\`/production (≥ ${minLength} chars: openssl rand -base64 48).`)
    } else if (secret.value.length < minLength) {
      push('error', 'env', `${label} (${secret.from}) is ${secret.value.length} characters — the app requires at least ${minLength}.`)
    } else if (INSECURE_SECRET.test(secret.value)) {
      push('error', 'env', `${label} (${secret.from}) looks like a placeholder — the app rejects it outside development.`)
    } else {
      push('ok', 'env', `${label} is set (${secret.from}, ${secret.value.length} characters).`)
    }
  }
  // Required variables: declared in src/env.ts without a default (from the
  // environment or .env, the way the dev entrypoints load it). Without a
  // readable schema, a Prisma app still needs DATABASE_URL.
  const required = requiredEnvKeys(envTs) ?? (ctx.options.prisma ? ['DATABASE_URL'] : [])
  for (const name of required) {
    const label = prefix ? `${prefix}_${name}` : name
    const found = lookup(name)
    if (found) {
      push('ok', 'env', `${label} is set (${found.from}).`)
      continue
    }
    const inExample = [label, name].some((key) => example[key] !== undefined && example[key] !== '')
    const fix =
      dotenvText === undefined
        ? exampleText !== undefined
          ? `\`cp .env.example .env\`${inExample ? '' : ` and set ${label} in it`}`
          : `create .env with ${label}=…`
        : `set ${label} in .env${inExample ? ' (.env.example has an example value)' : ''}`
    const database = name === 'DATABASE_URL' && ctx.options.prisma ? ' — and start PostgreSQL where it points' : ''
    push('error', 'env', `${label} is not set (environment or .env) — the app does not boot without it. Fix: ${fix}, or export it${database}.`)
  }

  // --- Prisma -------------------------------------------------------------------
  const schemaPath = join(dir, 'prisma', 'schema.prisma')
  const schema = await readText(schemaPath)
  if (schema !== undefined) {
    const output = /generator\s+\w+\s*\{[^}]*output\s*=\s*"([^"]+)"/.exec(schema)?.[1]
    const clientDir = output ? resolve(dirname(schemaPath), output) : join(dir, 'node_modules', '.prisma', 'client')
    if (!existsSync(clientDir)) {
      push('error', 'prisma', `Prisma client not generated (${clientDir.slice(dir.length + 1) || clientDir}) — run \`${ctx.pm === 'npm' ? 'npm run' : ctx.pm} db:generate\` (prisma generate).`)
    } else {
      push('ok', 'prisma', 'Prisma client is generated.')
    }
    const migrations = await readdir(join(dir, 'prisma', 'migrations'), { withFileTypes: true }).catch(() => [])
    const count = migrations.filter((entry) => entry.isDirectory()).length
    if (count === 0) push('warn', 'prisma', `No migrations yet — run \`${ctx.pm === 'npm' ? 'npm run' : ctx.pm} db:migrate\` (the app boots with assertMigrated).`)
    else push('info', 'prisma', `${count} migration(s) on disk; whether they are applied needs the database: \`prisma migrate status\`.`)
    const seedFix = legacySeedScriptFix(ctx.packageJson, await readText(join(dir, 'prisma.config.ts')))
    if (seedFix !== undefined) push('warn', 'prisma', seedFix)
  }

  // --- MCP -------------------------------------------------------------------------
  if (deps['@basaltkit/ai-mcp'] !== undefined) {
    const text = await readText(join(dir, '.mcp.json'))
    if (text === undefined) {
      push('warn', 'mcp', '@basaltkit/ai-mcp is installed but there is no .mcp.json — MCP clients will not find the dev bridge.')
    } else {
      let parsed: { mcpServers?: Record<string, { command?: unknown; args?: unknown }> } | undefined
      try {
        parsed = JSON.parse(text) as typeof parsed
      } catch (error) {
        push('error', 'mcp', `.mcp.json is not valid JSON: ${(error as Error).message}`)
      }
      if (parsed) {
        const servers = Object.values(parsed.mcpServers ?? {})
        const bridge = servers.some((server) => {
          const parts = [server.command, ...(Array.isArray(server.args) ? server.args : [])].map(String)
          return parts.some((part) => part.includes('@basaltkit/ai-mcp') || part.includes('basalt-ai-mcp'))
        })
        if (bridge) push('ok', 'mcp', '.mcp.json registers the basalt-ai-mcp dev bridge.')
        else push('warn', 'mcp', '.mcp.json has no server running @basaltkit/ai-mcp (basalt-ai-mcp).')
      }
    }
  }

  // --- Project tooling -------------------------------------------------------------
  const bin = await readText(join(dir, 'bin', 'basalt.ts'))
  const status = binStatus(bin, ctx.manifest?.files['bin/basalt.ts'])
  if (status === 'patchable') {
    push('warn', 'tooling', 'bin/basalt.ts is an older template (no .env loading / pre-boot project commands) — `npx create-basalt@latest update` patches it.')
  }
  if (status === 'modified') {
    push('info', 'tooling', 'bin/basalt.ts is customised and lacks the current preludes (project commands, .env loading, pre-boot `upgrade`) — see `create-basalt update` for the snippet.')
  }
  const dev = await readText(join(dir, 'src', 'dev.ts'))
  const devStatus = devEntryStatus(dev, ctx.manifest?.files['src/dev.ts'])
  if (devStatus === 'patchable') push('warn', 'tooling', 'src/dev.ts does not load .env (older template) — `npx create-basalt@latest update` patches it.')
  if (devStatus === 'modified') push('info', 'tooling', 'src/dev.ts is customised and does not load .env — see `create-basalt update` for the snippet.')
  if (!ctx.manifest) push('info', 'tooling', 'No .basalt/project.json (scaffolded before create-basalt 1.10) — features are inferred from package.json.')

  // --- Production path (BK-026) — static: nothing is built or started ----------
  const scripts = ctx.packageJson.scripts ?? {}
  const run = (script: string): string => `${ctx.pm === 'npm' ? 'npm run' : ctx.pm} ${script}`
  const start = scripts['start']
  const tsxIsDevOnly = ctx.packageJson.dependencies?.['tsx'] === undefined && ctx.packageJson.devDependencies?.['tsx'] !== undefined
  if (start !== undefined && RUNS_TSX.test(start) && tsxIsDevOnly) {
    push('warn', 'build', `\`start\` runs tsx ("${start}"), but tsx is only a devDependency — a production install (--prod) has no tsx. Build and run the compiled server: \`npx create-basalt@latest update\` prints the scripts.`)
  }
  if (scripts['build'] === undefined) {
    push('warn', 'build', `No \`build\` script — there is no tested way to run the app on plain node. \`npx create-basalt@latest update\` adds tsconfig.build.json and \`build\`.`)
  } else {
    const built = await mtimeOf(join(dir, PRODUCTION_ENTRY))
    const source = await newestMtime(join(dir, 'src'))
    if (built !== undefined && source !== undefined && source > built) {
      push('info', 'build', `${PRODUCTION_ENTRY} is older than src/ — run \`${run('build')}\` before \`${run('start')}\`.`)
    }
  }
  if (schema !== undefined) {
    if (LEGACY_PRISMA_OUTPUT.test(schema)) {
      push('warn', 'build', 'The Prisma client is generated under src/ — `tsc` does not copy its .js files, so the built app cannot load it. `npx create-basalt@latest update` prints how to move it to ./generated.')
    }
    if (deps['@prisma/client'] !== undefined && deps['@prisma/client-runtime-utils'] === undefined) {
      push('warn', 'build', 'The generated Prisma client requires @prisma/client-runtime-utils by name — declare it as a dependency (same range as @prisma/client), or plain `node` cannot load the client under pnpm.')
    }
  }

  return findings
}

async function mtimeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return undefined
  }
}

/** Newest modification time of the .ts files under `dir` (recursive), or undefined. */
async function newestMtime(dir: string): Promise<number | undefined> {
  let newest: number | undefined
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const path = join(dir, entry.name)
    const time = entry.isDirectory() ? await newestMtime(path) : entry.name.endsWith('.ts') ? await mtimeOf(path) : undefined
    if (time !== undefined && (newest === undefined || time > newest)) newest = time
  }
  return newest
}

export function renderFindings(findings: readonly DoctorFinding[], colors: Colors): string[] {
  const icon: Record<Level, string> = {
    ok: colors.green('✓'),
    info: colors.cyan('i'),
    warn: colors.yellow('!'),
    error: colors.red('✗'),
  }
  const lines = findings.map((finding) => `${icon[finding.level]} ${colors.dim(finding.area.padEnd(8))} ${finding.message}`)
  const errors = findings.filter((finding) => finding.level === 'error').length
  const warnings = findings.filter((finding) => finding.level === 'warn').length
  lines.push(
    '',
    errors > 0
      ? colors.red(`${errors} error(s), ${warnings} warning(s).`)
      : warnings > 0
        ? colors.yellow(`No errors, ${warnings} warning(s).`)
        : colors.green('All checks passed.'),
  )
  return lines
}

/** `create-basalt info`: a paste-able versions summary for bug reports. */
export async function projectInfo(ctx: ProjectContext, options: { nodeVersion?: string; pmVersion?: string } = {}): Promise<string[]> {
  const deps = allDependencies(ctx.packageJson)
  const enabled = (['tenancy', 'auth', 'billing', 'ui', 'cli', 'mcp', 'prisma'] as const).filter((key) => ctx.options[key])
  const lines = [
    `create-basalt  ${ownVersion()}`,
    `node           ${options.nodeVersion ?? process.versions.node}`,
    `os             ${platform()} ${arch()}`,
    `pm             ${ctx.pm}${options.pmVersion ? ` ${options.pmVersion}` : ''} (${ctx.pmSource})`,
    `app            ${ctx.options.name}${ctx.manifest ? ` (created with create-basalt ${ctx.manifest.createdWith})` : ''}`,
    `features       ${enabled.length > 0 ? enabled.join(', ') : 'none'}`,
    '',
    'package                       declared        installed',
  ]
  const interesting = Object.keys(deps)
    .filter((name) => alwaysLatest(name) || ['typescript', 'zod', 'prisma', '@prisma/client', 'tsx', 'vitest'].includes(name))
    .sort()
  for (const name of interesting) {
    const installed = (await installedVersion(ctx.dir, name)) ?? '-'
    lines.push(`${name.padEnd(30)}${(deps[name] as string).padEnd(16)}${installed}`)
  }
  if (ctx.web) {
    const webDeps = allDependencies(ctx.web.json)
    for (const name of Object.keys(webDeps).filter((dep) => dep.startsWith('@basaltkit/') || ['react', 'vite'].includes(dep)).sort()) {
      const installed = (await installedVersion(join(ctx.dir, 'web'), name)) ?? '-'
      lines.push(`${`web: ${name}`.padEnd(30)}${(webDeps[name] as string).padEnd(16)}${installed}`)
    }
  }
  return lines
}

/** Index of the first character at or after `from` that is not whitespace or a comment (linear scan). */
function skipTrivia(source: string, from: number): number {
  let i = from
  while (i < source.length) {
    const char = source[i]
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') i++
    else if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i)
      i = end === -1 ? source.length : end + 1
    } else if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 2
    } else break
  }
  return i
}
