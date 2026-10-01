import { hashContent } from './project/manifest.js'

/**
 * `bin/basalt.ts` — the app's `basalt` CLI (scaffolded with `--cli`, or added
 * later with `create-basalt add cli`).
 *
 * The file opens with the PROJECT-COMMANDS PRELUDE: `update`, `add`, `doctor`
 * and `info` are handed to create-basalt BEFORE anything of the app is
 * imported — those commands exist precisely for the moments the app does not
 * boot (mid-upgrade, a missing dependency). That is also why the dev tools
 * below are imported dynamically: a static import is evaluated before the
 * first statement, so a broken `@basaltkit/generator` would take `pnpm basalt
 * update` down with it.
 */
const PRELUDE = `import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Project commands run BEFORE anything of the app is imported, so they keep
// working while the app is broken mid-upgrade. create-basalt provides them —
// the project's devDependency when installed, else its latest release:
//   pnpm basalt update                  — update dependencies to the latest versions (--dry to preview)
//   pnpm basalt add ui                  — add a feature later (ui, cli, mcp)
//   pnpm basalt doctor                  — check the project's health
//   pnpm basalt info                    — versions summary for bug reports
const root = fileURLToPath(new URL('..', import.meta.url))
if (['update', 'add', 'doctor', 'info'].includes(process.argv[2] ?? '')) {
  process.exit(createBasalt(process.argv.slice(2)))
}

/** Runs create-basalt: the installed devDependency, else \`<pm> dlx create-basalt@latest\`. */
function createBasalt(args: string[]): number {
  const local = join(root, 'node_modules', 'create-basalt', 'dist', 'cli.js')
  if (existsSync(local)) {
    return spawnSync(process.execPath, [local, ...args], { cwd: root, stdio: 'inherit' }).status ?? 1
  }
  let declared = ''
  try {
    declared = String(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager ?? '')
  } catch {
    // No readable package.json: the lockfiles decide.
  }
  const uses = (pm: string, ...lockfiles: string[]): boolean =>
    declared.startsWith(\`\${pm}@\`) || lockfiles.some((file) => existsSync(join(root, file)))
  const [command, prefix]: [string, string[]] = uses('pnpm', 'pnpm-lock.yaml')
    ? ['pnpm', ['dlx']]
    : uses('bun', 'bun.lock', 'bun.lockb')
      ? ['bunx', []]
      : ['npx', ['--yes']]
  const result = spawnSync(command, [...prefix, 'create-basalt@latest', ...args], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  return result.status ?? 1
}
`

/**
 * The DEV PRELUDE, right after the project commands and still before anything
 * of the app is imported:
 *
 * - `upgrade` (the @basaltkit/cli codemods) only rewrites source files, so it
 *   runs without booting the app — it must keep working while the app cannot
 *   start (that is usually why you are upgrading);
 * - `.env` is loaded for development with `node --env-file` semantics: a
 *   variable already exported in the shell wins, the file only fills in what
 *   is missing (the app-prefixed names in src/env.ts exist because of exactly
 *   that rule). `pnpm start` / src/server.ts never loads it;
 * - a boot-time `EnvValidationError` becomes a fix (which variables, where they
 *   are read from, what to do) instead of a stack trace.
 */
const DEV_PRELUDE = `// \`upgrade\` (framework codemods) only rewrites source files: it runs without
// booting the app, so it works even while the app cannot start.
if (process.argv[2] === 'upgrade') {
  const { consoleIo, parseArgv, upgradeCommand } = await import('@basaltkit/cli')
  const { args, flags } = parseArgv(process.argv.slice(2))
  // upgradeCommand reads only io/args/flags — there is no app to hand it.
  const context = { io: consoleIo(), args, flags } as unknown as Parameters<typeof upgradeCommand.handle>[0]
  process.exit((await upgradeCommand.handle(context)) ?? 0)
}

// Development loads .env (when present) like \`node --env-file=.env\`: a variable
// already exported in your shell still wins, the file only fills in what is
// missing. \`pnpm start\` (production) never loads it — there the configuration
// comes from the real environment.
const envFile = join(root, '.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)

/**
 * A boot failure as a fix instead of a stack trace (stack: BASALT_DEBUG=1 or --debug):
 * invalid environment variables, a database that does not answer, one that is not
 * migrated. Anything else is rethrown untouched.
 */
async function explainBootFailure(error: unknown): Promise<never> {
  const failure = (error ?? {}) as { code?: unknown; report?: unknown; message?: unknown; cause?: unknown; errors?: unknown }
  const message = String(failure.message ?? '')
  const codes = [failure, failure.cause, ...(Array.isArray(failure.errors) ? failure.errors : [])].map((item) =>
    String((item as { code?: unknown } | null | undefined)?.code ?? ''),
  )
  const unreachable =
    codes.some((code) => /^(ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|EAI_AGAIN|P1001|P1002)$/.test(code)) ||
    /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|Can't reach database server/.test(message) ||
    // assertMigrated could not even query the database (down, wrong host/port or credentials).
    (failure.code === 'PRISMA_NOT_MIGRATED' && message.startsWith('Could not verify'))
  const debugHint = 'BASALT_DEBUG=1 shows the stack trace.'
  let explanation: string | undefined
  if (failure.code === 'ENV_INVALID' && Array.isArray(failure.report)) {
    const hasEnvFile = existsSync(envFile)
    explanation = [
      'The app cannot start — invalid environment variables:',
      ...failure.report.map((line) => '  - ' + String(line)),
      '',
      "Read from: your shell's environment" +
        (hasEnvFile ? ' and ' + envFile + ' (exported variables win).' : ' only — there is no ' + envFile + '.'),
      'Fix: ' + (hasEnvFile ? 'set them in .env' : 'cp .env.example .env, then fill them in') + ' (or export them)' +
        (existsSync(join(root, 'prisma')) ? ' — for DATABASE_URL, start PostgreSQL and point the URL at it' : '') +
        '. \`pnpm basalt doctor\` checks the environment; ' + debugHint,
    ].join('\\n')
  } else if (unreachable || failure.code === 'PRISMA_NOT_MIGRATED') {
    const database = await databaseInUse()
    const where = 'Database: ' + database.target + ' (from ' + database.name + '; credentials never shown).'
    explanation = unreachable
      ? [
          'The app cannot start — the database did not answer.',
          where,
          'Fix: start PostgreSQL (e.g. \`docker compose up -d\`, or your local service) and check that ' +
            database.name + ' in .env points at it (host, port, user, password); on a new database, then run \`pnpm db:migrate\`. ' + debugHint,
        ].join('\\n')
      : [
          'The app cannot start — the database is not migrated:',
          '  ' + message,
          where,
          'Fix: run \`pnpm db:migrate\` (development; \`pnpm db:deploy\` in production) — or, if this is not the database you meant, check ' +
            database.name + ' (a shell may have exported another project\\'s). ' + debugHint,
        ].join('\\n')
  }
  if (explanation === undefined || process.env['BASALT_DEBUG'] === '1' || process.argv.includes('--debug')) throw error
  console.error(explanation)
  process.exit(1)
}

/** The database URL the app booted with — protocol, host, port and database only, never the credentials. */
async function databaseInUse(): Promise<{ name: string; target: string }> {
  let url: unknown
  try {
    url = ((await import('../src/env.js')).env as unknown as Record<string, unknown>)['DATABASE_URL']
  } catch {
    // env.ts itself failed: there is no URL to show.
  }
  // The variable it came from: the app-prefixed name first (it wins in src/env.ts).
  const name =
    Object.keys(process.env)
      .filter((key) => key.endsWith('DATABASE_URL') && process.env[key] === url)
      .sort((a, b) => b.length - a.length)[0] ?? 'DATABASE_URL'
  try {
    const parsed = new URL(String(url))
    return { name, target: parsed.protocol + '//' + parsed.hostname + ':' + (parsed.port || '5432') + parsed.pathname }
  } catch {
    return { name, target: '(no valid URL)' }
  }
}
`

/** Marker proving a bin/basalt.ts already delegates the project commands. */
export const PROJECT_COMMANDS_MARKER = "['update', 'add', 'doctor', 'info'].includes(process.argv[2]"

/** Marker proving a bin/basalt.ts already has the dev prelude (.env loading, `upgrade`, env errors). */
export const DEV_PRELUDE_MARKER = 'process.loadEnvFile(envFile)'

const APP_IMPORT = "await import('../src/app.js')"
const APP_IMPORT_EXPLAINED = `${APP_IMPORT}.catch(explainBootFailure)`
const RUN_CLI = 'process.exit(await runCli({ app })'

export function basaltBin(): string {
  return `#!/usr/bin/env node
${PRELUDE}
${DEV_PRELUDE}
// The dev tools are imported dynamically, after the project commands above.
const { runCli } = await import('@basaltkit/cli')
const { generatorCommands } = await import('@basaltkit/generator')
const { prismaSyncCommand } = await import('@basaltkit/prisma')

// Dev tooling: opt into development defaults unless NODE_ENV is already set
// (imported dynamically below so env.ts is evaluated after this line).
process.env['NODE_ENV'] ??= 'development'
const { buildApp } = ${APP_IMPORT_EXPLAINED}

// The 'basalt' CLI: boots the app WITH the dev/CLI commands, runs one, shuts down.
// The dev tools (@basaltkit/generator; add @basaltkit/ai for ai:*) are imported
// ONLY here — the runtime server (src/server.ts) never loads them, so the SaaS
// runs without the codegen/AI layer.
//   pnpm basalt dev                     — dev server: route table + watch (--worker for a queue worker)
//   pnpm basalt list                    — show available commands
//   pnpm basalt routes                  — list registered HTTP routes
//   pnpm basalt make:resource Project   — generate a full resource vertical
//   pnpm basalt make:service Project    — generate a single artifact (schema/service/…)
const app = buildApp({
  logLevel: 'silent',
  commands: [...generatorCommands(), prismaSyncCommand()],
})
process.exit(await runCli({ app }).catch(explainBootFailure))
`
}

/**
 * Hashes of every bin/basalt.ts an earlier create-basalt release generated
 * (CRLF-insensitive). Only these — or a file the project's manifest records as
 * untouched — are patched automatically.
 */
export const LEGACY_BIN_HASHES: ReadonlySet<string> = new Set([
  // create-basalt 0.x (rebrand, 2026-08-09): static imports, no dev commands.
  'sha256-78537f4bf21ca44d78dc50f8841f39898b86300c4eb2c696f3d1a6e6c9921cbd',
  // 2026-08-13: generator + prisma:sync passed via `commands`.
  'sha256-0c898eb1faf32792fc9d2593070c8421905882ba8d8f2aba9a69c74ce2dfa5d8',
  // 2026-08-22: `basalt dev` documented.
  'sha256-d09d583f1a39bffcb72f302c5f6c3e2651badea358ba38019238a4aa4b842545',
  // 2026-09-19 (create-basalt ≤ 1.9): NODE_ENV defaulted before the app import.
  'sha256-a0df89dee04091a9470f67968ff72cfc3bf64076c1bf3d141ae657c7438a94c8',
  // 2026-10-01 (create-basalt 1.10): project commands (update/add/doctor/info)
  // delegated before boot — but no .env loading and `upgrade` booted the app.
  'sha256-9091e137a5de39929d0e70b2fd973386b9cc1c2f996e130989a22c795b9d0893',
])

export const hasProjectCommands = (content: string): boolean => content.includes(PROJECT_COMMANDS_MARKER)
export const hasDevPrelude = (content: string): boolean => content.includes(DEV_PRELUDE_MARKER)

/**
 * Upgrades a template-generated bin/basalt.ts to the current template, step by
 * step: (1) without the project commands, inserts their prelude after the
 * shebang and turns the remaining static imports into dynamic ones (so they no
 * longer run before it); (2) without the dev prelude, inserts it right after
 * the project commands and routes the app import through `explainBootFailure`.
 * Deterministic for the known templates — for the latest ones (1.9, 1.10) the
 * result is exactly {@link basaltBin}.
 */
export function patchBasaltBin(content: string): string {
  let text = content.replace(/\r\n/g, '\n')
  if (!hasProjectCommands(text)) text = addProjectCommands(text)
  if (!hasDevPrelude(text)) text = addDevPrelude(text)
  return text
}

function addProjectCommands(content: string): string {
  const lines = content.split('\n')
  const shebang = lines[0]?.startsWith('#!') ? `${lines.shift()}\n` : ''
  const body = lines.map((line) => {
    const match = /^import \{ ([^}]+) \} from '([^']+)'$/.exec(line)
    return match ? `const { ${match[1]} } = await import('${match[2]}')` : line
  })
  const firstDynamic = body.findIndex((line) => line.startsWith('const {') && line.includes('= await import('))
  if (firstDynamic >= 0 && !(body[firstDynamic] ?? '').includes("'../src/app.js'")) {
    body.splice(firstDynamic, 0, '// The dev tools are imported dynamically, after the project commands above.')
  }
  return `${shebang}${PRELUDE}\n${body.join('\n')}`
}

function addDevPrelude(content: string): string {
  const at = content.indexOf(PRELUDE)
  // A file without the template's prelude block is not ours to rearrange.
  if (at < 0) return content
  const end = at + PRELUDE.length + (content.startsWith('\n', at + PRELUDE.length) ? 1 : 0)
  const rest = content
    .slice(end)
    .replace(`= ${APP_IMPORT}\n`, `= ${APP_IMPORT_EXPLAINED}\n`)
    .replace(`${RUN_CLI})\n`, `${RUN_CLI}.catch(explainBootFailure))\n`)
  return `${content.slice(0, end)}${DEV_PRELUDE}\n${rest}`
}

export type BinStatus = 'current' | 'patchable' | 'modified' | 'absent'

/** Where a bin/basalt.ts stands: already current, an untouched old template, or user code. */
export function binStatus(content: string | undefined, manifestHash?: string): BinStatus {
  if (content === undefined) return 'absent'
  if (hasProjectCommands(content) && hasDevPrelude(content)) return 'current'
  const hash = hashContent(content)
  return LEGACY_BIN_HASHES.has(hash) || hash === manifestHash ? 'patchable' : 'modified'
}

/** What to paste by hand into a customised bin/basalt.ts (only the parts it lacks). */
export function manualBinSnippet(content: string): string {
  const steps: string[] = []
  if (!hasProjectCommands(content)) {
    steps.push(`Paste this right after the shebang line of bin/basalt.ts, then turn its
static imports of @basaltkit/* and ../src/app.js into dynamic ones
(\`import { runCli } from '@basaltkit/cli'\` → \`const { runCli } = await import('@basaltkit/cli')\`)
so they no longer run before it:

${PRELUDE}`)
  }
  if (!hasDevPrelude(content)) {
    steps.push(`${steps.length > 0 ? 'Then paste' : 'Paste'} this after the project-commands block (before anything of the app is
imported) — it runs \`upgrade\` without booting the app, loads .env for development
and explains env errors — and change the app import to
\`const { buildApp } = ${APP_IMPORT_EXPLAINED}\`:

${DEV_PRELUDE}`)
  }
  return steps.join('\n')
}
