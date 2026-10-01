import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PackageManager } from '../index.js'
import type { ResolveLatestOptions } from '../latest-versions.js'
import { ADDABLE_FEATURES, AddRefusedError, planAdd, type AddableFeature, type AddPlan } from './add.js'
import { loadProject, NotABasaltAppError, type ProjectContext } from './context.js'
import { projectInfo, renderFindings, runDoctor } from './doctor.js'
import { colorsEnabled, makeColors, type Colors, type Out } from './term.js'
import { planUpdate, RegistryUnavailableError, renderUpdatePlan, type FileWrite } from './update.js'

/**
 * The project commands — `create-basalt update | add | doctor | info` — run
 * inside an EXISTING app (any app, with or without `--cli`). In a scaffolded
 * app they are also reachable as `pnpm basalt <command>`: bin/basalt.ts (with
 * `--cli`) or the `basalt` script (`create-basalt --project`) hands them here.
 *
 * Every side effect goes through {@link ProjectCommandDeps}, so the commands
 * are tested with temp dirs, a fake registry and a fake package manager.
 */

export const PROJECT_COMMANDS = ['update', 'add', 'doctor', 'info'] as const
export type ProjectCommand = (typeof PROJECT_COMMANDS)[number]
export const isProjectCommand = (token: string | undefined): token is ProjectCommand =>
  (PROJECT_COMMANDS as readonly string[]).includes(token ?? '')

export interface ProjectCommandDeps {
  /** Directory to operate in (overridden by --cwd). */
  cwd: string
  out: Out
  env: NodeJS.ProcessEnv
  /** Whether a human can answer a prompt (stdin is a TTY and not CI). */
  interactive: boolean
  /** Whether stdout is a terminal (colors). */
  isTTY: boolean
  /** Registry knobs (fetch, registry URL, clock, release-age window) — tests inject a fake fetch. */
  registry?: ResolveLatestOptions
  /** Runs a command with inherited stdio; resolves false on failure (never throws). */
  run(command: string, args: string[], cwd: string): Promise<boolean>
  /** Runs a command and returns its trimmed stdout (undefined on failure). */
  capture(command: string, args: string[], cwd: string): Promise<string | undefined>
  /** Asks a yes/no question (default yes). */
  confirm(message: string): Promise<boolean>
  /** Applies the installed @basaltkit/cli upgrade codemods. Default: {@link runInstalledCodemods}. */
  codemods?(dir: string, out: Out, colors: Colors): Promise<void>
  nodeVersion?: string
}

const COMMON_FLAGS = `Common options:
  --cwd=<dir>     The app to operate on (default: the current directory)
  --pm=<manager>  Package manager: pnpm | npm | yarn | bun (default: packageManager
                  field, then the lockfile)
  --no-color      Plain output (also: NO_COLOR=1)
  -h, --help      Show this help`

export const PROJECT_USAGE = `Project commands — run inside an existing Basalt app:

  create-basalt update [options]      Update dependencies to their latest versions
  create-basalt add <feature>         Add ui | cli | mcp to the app
  create-basalt doctor                Check the project's health (read-only)
  create-basalt info                  Versions summary for bug reports

In a scaffolded app: pnpm basalt <command>. Each command has --help.
`

export const COMMAND_USAGE: Record<ProjectCommand, string> = {
  update: `Usage: create-basalt update [options]   (in an app: pnpm basalt update)

Updates the app's dependencies (package.json, and web/package.json when
present) to their latest published versions, with the scaffold's policy:
  - @basaltkit/* and create-basalt: always the latest, across majors (each
    framework major prints a link to its changelog);
  - third-party packages: the newest release on the app's CURRENT major (a new
    major is reported; take it with --major);
  - versions younger than the release-age window (pnpm minimumReleaseAge) are
    left for later, so the install cannot refuse them.
Range style (^, ~, exact) and package.json formatting are preserved. Then it
installs, runs the @basaltkit/cli upgrade codemods, and suggests typecheck+test.
It also upgrades project tooling: an unmodified old bin/basalt.ts gains the
project commands, .env loading for development and a pre-boot \`upgrade\`; an
unmodified src/dev.ts loads .env; the .env.example header is refreshed;
create-basalt becomes a devDependency (pnpm basalt update).

Options:
  --dry           Show the plan, write nothing
  -y, --yes       Apply without asking
  --major         Let third-party packages cross a major too
  --only=@basaltkit
                  Only the framework packages (and create-basalt)
  --no-install    Write package.json, skip the install (and the codemods)
  --no-tooling    Leave bin/basalt.ts, src/dev.ts, .env.example and the
                  create-basalt devDependency alone
${COMMON_FLAGS}
`,
  add: `Usage: create-basalt add <feature> [options]   (in an app: pnpm basalt add <feature>)

Adds what the matching scaffold flag generates to an existing app:
  ui    the web/ frontend (React + shadcn + SDK), as --ui scaffolds it; adapted
        to the app (name, auth). pnpm projects only (web/ is a workspace member)
  cli   bin/basalt.ts (generators, prisma:sync, project commands) + its deps
  mcp   @basaltkit/mcp at POST /mcp, the dev-only ai-mcp bridge and .mcp.json

Existing files are never overwritten (skipped with a notice) unless --force;
package.json, pnpm-workspace.yaml, .gitignore and README are merged. Your code
(src/app.ts, src/routes.ts) is regenerated only when .basalt/project.json
proves it untouched, patched where the template's anchors are unambiguous, and
otherwise left alone with the exact manual steps printed.

Options:
  --dry           Show the plan, write nothing
  -y, --yes       Apply without asking
  --force         Overwrite existing generated files
  --no-install    Skip the dependency install
  --offline       Use the dependency ranges bundled with this create-basalt
${COMMON_FLAGS}
`,
  doctor: `Usage: create-basalt doctor [options]   (in an app: pnpm basalt doctor)

Read-only health check: Node vs engines, package manager and lockfiles,
installed vs declared versions, duplicated @basaltkit versions and unmet peer
ranges, framework packages behind latest, the required variables of src/env.ts
and the auth secret (from the environment or .env), Prisma client/migrations,
.mcp.json, and whether bin/basalt.ts / src/dev.ts are current.
Exits 1 when an error is found; warnings alone exit 0.

Options:
  --offline       Skip the registry ("behind latest") check
${COMMON_FLAGS}
`,
  info: `Usage: create-basalt info [options]   (in an app: pnpm basalt info)

Prints create-basalt, Node, OS, package manager, the app's features and the
declared/installed versions of the framework and key tools — paste it into a
bug report.

${COMMON_FLAGS}
`,
}

interface ParsedFlags {
  positionals: string[]
  values: Record<string, string>
  switches: Record<string, boolean>
}

const KNOWN: Record<ProjectCommand, { switches: string[]; values: string[] }> = {
  update: { switches: ['dry', 'yes', 'major', 'install', 'tooling', 'offline'], values: ['only'] },
  add: { switches: ['dry', 'yes', 'force', 'install', 'offline'], values: [] },
  doctor: { switches: ['offline'], values: [] },
  info: { switches: [], values: [] },
}

function parseFlags(argv: readonly string[]): ParsedFlags | string {
  const parsed: ParsedFlags = { positionals: [], values: {}, switches: {} }
  for (const token of argv) {
    if (token === '-y') parsed.switches['yes'] = true
    else if (token === '-h') parsed.switches['help'] = true
    else if (token.startsWith('--')) {
      const body = token.slice(2)
      const eq = body.indexOf('=')
      if (eq >= 0) parsed.values[body.slice(0, eq)] = body.slice(eq + 1)
      else if (body.startsWith('no-')) parsed.switches[body.slice(3)] = false
      else parsed.switches[body === 'dry-run' ? 'dry' : body] = true
    } else if (token.startsWith('-')) return `Unknown option ${token}.`
    else parsed.positionals.push(token)
  }
  return parsed
}

const pmRun = (pm: PackageManager, script: string): string =>
  pm === 'npm' ? `npm run ${script}` : pm === 'bun' ? `bun run ${script}` : `${pm} ${script}`
/** `pnpm basalt <args>` in that manager's spelling (npm needs `--` before flags). */
export const basaltCommand = (pm: PackageManager, args: string): string =>
  pm === 'npm' ? `npm run basalt -- ${args}` : `${pmRun(pm, 'basalt')} ${args}`
const pmTest = (pm: PackageManager): string => (pm === 'bun' ? 'bun run test' : `${pm} test`)

async function writeAll(dir: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
}

/** Runs one project command; returns the process exit code. */
export async function runProjectCommand(argv: readonly string[], deps: ProjectCommandDeps): Promise<number> {
  const { out } = deps
  const parsed = parseFlags(argv)
  const colorFlag = typeof parsed === 'string' ? undefined : parsed.switches['color']
  const colors = makeColors(colorFlag === false ? false : colorsEnabled(deps.env, deps.isTTY))
  if (typeof parsed === 'string') {
    out.error(colors.red(parsed))
    return 1
  }
  const [command, ...rest] = parsed.positionals
  if (!isProjectCommand(command)) {
    out.log(PROJECT_USAGE)
    return command === undefined ? 0 : 1
  }
  if (parsed.switches['help']) {
    out.log(COMMAND_USAGE[command])
    return 0
  }
  const known = KNOWN[command]
  const common = ['help', 'color']
  for (const name of Object.keys(parsed.switches)) {
    if (!known.switches.includes(name) && !common.includes(name)) {
      out.error(colors.red(`Unknown option --${name} for "${command}". See: create-basalt ${command} --help`))
      return 1
    }
  }
  for (const name of Object.keys(parsed.values)) {
    if (!known.values.includes(name) && name !== 'cwd' && name !== 'pm') {
      out.error(colors.red(`Unknown option --${name}= for "${command}". See: create-basalt ${command} --help`))
      return 1
    }
  }
  const pmFlag = parsed.values['pm']
  if (pmFlag !== undefined && !['pnpm', 'npm', 'yarn', 'bun'].includes(pmFlag)) {
    out.error(colors.red(`--pm must be pnpm, npm, yarn or bun (got "${pmFlag}").`))
    return 1
  }
  const dir = resolve(deps.cwd, parsed.values['cwd'] ?? '.')

  let ctx: ProjectContext
  try {
    ctx = await loadProject(dir, pmFlag as PackageManager | undefined, deps.env['npm_config_user_agent'] ?? '')
  } catch (error) {
    if (error instanceof NotABasaltAppError) {
      out.error(colors.red(error.message))
      if (!existsSync(join(dir, 'package.json'))) {
        out.error(`(To scaffold a new project literally named "${command}", use: npm create basalt -- --name=${command})`)
      }
      return 1
    }
    throw error
  }

  const s = parsed.switches
  switch (command) {
    case 'update':
      return update(ctx, deps, colors, {
        dry: s['dry'] === true,
        yes: s['yes'] === true,
        major: s['major'] === true,
        install: s['install'] !== false,
        tooling: s['tooling'] !== false,
        offline: s['offline'] === true,
        only: parsed.values['only'],
      })
    case 'add':
      return add(ctx, deps, colors, rest[0], {
        dry: s['dry'] === true,
        yes: s['yes'] === true,
        force: s['force'] === true,
        install: s['install'] !== false,
        offline: s['offline'] === true,
      })
    case 'doctor': {
      const pmVersion = await deps.capture(ctx.pm, ['--version'], ctx.dir)
      const findings = await runDoctor(ctx, {
        env: deps.env,
        offline: s['offline'] === true,
        ...(deps.registry ? { registry: deps.registry } : {}),
        ...(deps.nodeVersion ? { nodeVersion: deps.nodeVersion } : {}),
        ...(pmVersion ? { pmVersion } : {}),
      })
      out.log(colors.bold(`basalt doctor — ${ctx.options.name}`))
      out.log('')
      for (const line of renderFindings(findings, colors)) out.log(line)
      return findings.some((finding) => finding.level === 'error') ? 1 : 0
    }
    case 'info': {
      const pmVersion = await deps.capture(ctx.pm, ['--version'], ctx.dir)
      const lines = await projectInfo(ctx, {
        ...(deps.nodeVersion ? { nodeVersion: deps.nodeVersion } : {}),
        ...(pmVersion ? { pmVersion } : {}),
      })
      for (const line of lines) out.log(line)
      return 0
    }
  }
}

/** Asks before writing; false = do not apply. Non-interactive without --yes refuses (prints how). */
async function approve(deps: ProjectCommandDeps, colors: Colors, yes: boolean, again: string): Promise<boolean> {
  if (yes) return true
  if (!deps.interactive) {
    deps.out.log('')
    deps.out.log(colors.yellow(`Not a terminal — nothing written. Re-run with --yes to apply: ${again}`))
    return false
  }
  return deps.confirm('Apply these changes?')
}

async function installAndReport(
  ctx: ProjectContext,
  deps: ProjectCommandDeps,
  colors: Colors,
  pm: PackageManager,
  written: readonly string[],
): Promise<boolean> {
  deps.out.log('')
  deps.out.log(colors.bold(`Installing with ${pm}…`))
  const ok = await deps.run(pm, ['install'], ctx.dir)
  if (!ok) {
    deps.out.error(colors.red(`${pm} install failed. The file changes are kept so you can fix the cause and re-run \`${pm} install\`.`))
    deps.out.error(`To undo them instead: git checkout -- ${written.join(' ')}   (or git restore …)`)
  }
  return ok
}

interface UpdateFlags {
  dry: boolean
  yes: boolean
  major: boolean
  install: boolean
  tooling: boolean
  offline: boolean
  only: string | undefined
}

async function update(ctx: ProjectContext, deps: ProjectCommandDeps, colors: Colors, flags: UpdateFlags): Promise<number> {
  const { out } = deps
  if (flags.offline) {
    out.error(colors.red('update resolves the latest versions from the npm registry, so it cannot run with --offline.'))
    out.error('Drop --offline (a private registry is honored through npm_config_registry).')
    return 1
  }
  let only: 'basaltkit' | undefined
  if (flags.only !== undefined) {
    if (!['@basaltkit', 'basaltkit', '@basaltkit/*', 'framework'].includes(flags.only)) {
      out.error(colors.red(`--only accepts @basaltkit (got "${flags.only}").`))
      return 1
    }
    only = 'basaltkit'
  }
  out.log(colors.dim(`Resolving the latest versions for ${ctx.options.name} (${ctx.pm})…`))
  let plan
  try {
    plan = await planUpdate(ctx, {
      major: flags.major,
      tooling: flags.tooling,
      ...(only ? { only } : {}),
      ...(deps.registry ? { registry: deps.registry } : {}),
    })
  } catch (error) {
    if (error instanceof RegistryUnavailableError) {
      out.error(colors.red(error.message))
      return 1
    }
    throw error
  }
  out.log('')
  for (const line of renderUpdatePlan(plan, colors)) out.log(line)
  const paths = Object.keys(plan.files)
  if (paths.length === 0) return 0
  out.log('')
  out.log(`${flags.dry ? 'Would write' : 'Writes'}: ${paths.join(', ')}`)
  if (flags.dry) {
    out.log(colors.dim('Dry run — nothing written.'))
    return 0
  }
  if (!(await approve(deps, colors, flags.yes, basaltCommand(ctx.pm, 'update --yes')))) return flags.yes || deps.interactive ? 0 : 1
  await writeAll(
    ctx.dir,
    Object.fromEntries(Object.entries(plan.files).map(([path, write]: [string, FileWrite]) => [path, write.after])),
  )
  out.log(colors.green(`✓ Updated ${paths.join(', ')}.`))
  if (!flags.install) {
    out.log('')
    out.log(`Next: ${ctx.pm} install, then ${basaltCommand(ctx.pm, 'upgrade')} (codemods, with --cli) and ${pmRun(ctx.pm, 'typecheck')} && ${pmTest(ctx.pm)}`)
    return 0
  }
  if (!(await installAndReport(ctx, deps, colors, ctx.pm, paths))) return 1
  if (plan.updates.some((entry) => entry.framework)) {
    out.log('')
    await (deps.codemods ?? runInstalledCodemods)(ctx.dir, out, colors)
  }
  out.log('')
  out.log(colors.bold(`Next: ${pmRun(ctx.pm, 'typecheck')} && ${pmTest(ctx.pm)}`))
  return 0
}

interface AddFlags {
  dry: boolean
  yes: boolean
  force: boolean
  install: boolean
  offline: boolean
}

export function renderAddPlan(plan: AddPlan, colors: Colors): string[] {
  const lines: string[] = []
  const mark = {
    create: colors.green('+ create   '),
    overwrite: colors.red('! overwrite'),
    update: colors.yellow('~ update   '),
    skip: colors.dim('- skip     '),
  }
  for (const change of plan.changes) {
    lines.push(`  ${mark[change.action]} ${change.path}${change.note ? colors.dim(`  (${change.note})`) : ''}`)
  }
  for (const note of plan.notes) lines.push('', colors.dim(note))
  for (const step of plan.manual) lines.push('', colors.yellow('Manual step:'), step)
  return lines
}

async function add(
  ctx: ProjectContext,
  deps: ProjectCommandDeps,
  colors: Colors,
  feature: string | undefined,
  flags: AddFlags,
): Promise<number> {
  const { out } = deps
  if (!(ADDABLE_FEATURES as readonly string[]).includes(feature ?? '')) {
    out.error(colors.red(feature ? `Unknown feature "${feature}".` : 'Which feature?') + ` Available: ${ADDABLE_FEATURES.join(', ')}.`)
    return 1
  }
  let plan: AddPlan
  try {
    plan = await planAdd(ctx, feature as AddableFeature, {
      force: flags.force,
      resolveLatest: !flags.offline,
      ...(deps.registry ? { registry: deps.registry } : {}),
    })
  } catch (error) {
    if (error instanceof AddRefusedError) {
      out.error(colors.red(error.message))
      return 1
    }
    throw error
  }
  if (plan.alreadyPresent) {
    out.log(`${feature} is already part of ${ctx.options.name} (${plan.alreadyPresent}) — nothing to do. Use --force to regenerate its files.`)
    return 0
  }
  out.log(colors.bold(`add ${feature} → ${ctx.options.name}`))
  out.log('')
  for (const line of renderAddPlan(plan, colors)) out.log(line)
  const writes = plan.changes.filter((change) => change.action !== 'skip' && change.content !== undefined)
  if (writes.length === 0) {
    out.log('')
    out.log('Nothing to write.')
    return 0
  }
  if (flags.dry) {
    out.log('')
    out.log(colors.dim('Dry run — nothing written.'))
    return 0
  }
  out.log('')
  if (!(await approve(deps, colors, flags.yes, basaltCommand(ctx.pm, `add ${feature} --yes`)))) return flags.yes || deps.interactive ? 0 : 1
  await writeAll(ctx.dir, Object.fromEntries(writes.map((change) => [change.path, change.content as string])))
  out.log(colors.green(`✓ Wrote ${writes.length} file(s).`))
  const needsInstall = writes.some((change) => change.path.endsWith('package.json'))
  if (needsInstall && flags.install) {
    if (!(await installAndReport(ctx, deps, colors, ctx.pm, writes.map((change) => change.path)))) return 1
  }
  const steps: string[] = []
  if (needsInstall && !flags.install) steps.push(`${ctx.pm} install`)
  if (feature === 'ui') steps.push(`${pmRun(ctx.pm, 'dev')}      # API on :3000`, `${pmRun(ctx.pm, 'dev:web')}  # UI on http://localhost:5180`)
  if (feature === 'cli') steps.push(basaltCommand(ctx.pm, 'list'))
  if (feature === 'mcp') {
    steps.push(`${pmRun(ctx.pm, 'dev')}`, `curl -s localhost:3000/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`)
  }
  steps.push(`${pmRun(ctx.pm, 'typecheck')} && ${pmTest(ctx.pm)}`)
  out.log('')
  out.log(colors.bold('Next:'))
  for (const step of steps) out.log(`  ${step}`)
  return 0
}

/**
 * Runs the upgrade codemods of the app's INSTALLED @basaltkit/cli (the version
 * just installed knows the migrations for itself) without booting the app.
 */
export async function runInstalledCodemods(dir: string, out: Out, colors: Colors): Promise<void> {
  const root = join(dir, 'node_modules', '@basaltkit', 'cli')
  let entry: string
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      exports?: { '.'?: { import?: string } }
      main?: string
    }
    entry = pkg.exports?.['.']?.import ?? pkg.main ?? 'dist/index.js'
  } catch {
    out.log(colors.dim('No @basaltkit/cli installed — no upgrade codemods to run.'))
    return
  }
  try {
    const cli = (await import(pathToFileURL(join(root, entry)).href)) as {
      runUpgrade?: (
        migrations: unknown[],
        fs: unknown,
        options: { dir: string },
      ) => Promise<{ migration: string; changed: string[] }[]>
      MIGRATIONS?: unknown[]
    }
    if (typeof cli.runUpgrade !== 'function' || !Array.isArray(cli.MIGRATIONS)) return
    const reports = await cli.runUpgrade(cli.MIGRATIONS, projectUpgradeFs(dir), { dir })
    const changed = reports.filter((report) => report.changed.length > 0)
    if (changed.length === 0) {
      out.log(colors.dim('Upgrade codemods: nothing to change.'))
      return
    }
    for (const report of changed) {
      out.log(`Codemod ${report.migration}: ${report.changed.length} file(s)`)
      for (const path of report.changed) out.log(`  ${path}`)
    }
  } catch (error) {
    out.error(colors.yellow(`Upgrade codemods failed: ${(error as Error).message} — run \`basalt upgrade --dry\` to inspect.`))
  }
}

/** An @basaltkit/cli UpgradeFs rooted at `dir` (relative paths resolve against it, not process.cwd()). */
export function projectUpgradeFs(dir: string): {
  list(root: string): Promise<string[]>
  read(path: string): Promise<string>
  write(path: string, content: string): Promise<void>
} {
  const SKIP = new Set(['node_modules', 'dist', '.git', '.next', 'build', 'coverage', 'generated'])
  const at = (path: string): string => (isAbsolute(path) ? path : join(dir, path))
  return {
    async list(root) {
      const base = at(root)
      const files: string[] = []
      const walk = async (current: string): Promise<void> => {
        for (const entry of await readdir(current, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            if (!SKIP.has(entry.name)) await walk(join(current, entry.name))
          } else files.push(relative(base, join(current, entry.name)))
        }
      }
      await walk(base)
      return files
    },
    read: (path) => readFile(at(path), 'utf8'),
    write: (path, content) => writeFile(at(path), content, 'utf8'),
  }
}
