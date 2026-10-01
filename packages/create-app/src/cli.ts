#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process'
import { stdin, stdout } from 'node:process'
import {
  createProject,
  describeResolution,
  detectPackageManager,
  resolveRunDefaults,
  runWizard,
  ttyPrompter,
  TargetNotEmptyError,
  WizardCancelledError,
} from './index.js'
import { basaltCommand, isProjectCommand, runProjectCommand } from './project/run.js'
import { parseArgs, resolvesLatest, USAGE } from './args.js'
import { envPrefix } from './templates.js'

/** Runs a command inheriting stdio; resolves false on non-zero exit (never throws). */
function run(command: string, args: string[], cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}

/** Runs a command and returns its trimmed stdout, or undefined (never throws). */
function capture(command: string, args: string[], cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, shell: process.platform === 'win32', timeout: 10_000 }, (error, out) => {
      resolve(error ? undefined : String(out).trim() || undefined)
    })
  })
}

/** Cleanly abort on Ctrl+C instead of dumping a Node AbortError stack trace. */
function cancel(): never {
  stdout.write('\nCancelled.\n')
  process.exit(130) // 128 + SIGINT
}

const argv = process.argv.slice(2)

// Project commands (update | add | doctor | info) operate on an EXISTING app.
// They are selected by the first positional argument — those four words are
// reserved, so a project literally named "update" is created with
// --name=update. `--project` (the `basalt` script of apps without --cli) forces
// project mode: `pnpm basalt` alone then prints the project-command help.
const firstPositional = argv.find((token) => !token.startsWith('-'))
if (argv.includes('--project') || isProjectCommand(firstPositional)) {
  const code = await runProjectCommand(
    argv.filter((token) => token !== '--project'),
    {
      cwd: process.cwd(),
      out: { log: (line = '') => stdout.write(`${line}\n`), error: (line) => process.stderr.write(`${line}\n`) },
      env: process.env,
      interactive: Boolean(stdin.isTTY) && !process.env['CI'],
      isTTY: Boolean(stdout.isTTY),
      run,
      capture,
      confirm: async (message) => {
        try {
          return await ttyPrompter().confirm({ message, initial: true })
        } catch (error) {
          if (error instanceof WizardCancelledError) cancel()
          throw error
        }
      },
    },
  )
  process.exit(code)
}

const flags = parseArgs(argv)

// Rich interactive wizard when nothing was specified in a terminal. CI, piped
// input, and `--yes` keep the flag-driven path.
if (!flags.yes && flags.name === undefined && stdin.isTTY) {
  try {
    const result = await runWizard(ttyPrompter(), {
      defaultPm: flags.pm ?? detectPackageManager(),
    })
    flags.name = result.name
    flags.tenancy = result.tenancy
    flags.auth = result.auth
    flags.billing = result.billing
    flags.ui = result.ui
    flags.cli = result.cli
    flags.mcp = result.mcp
    flags.prisma = result.prisma
    flags.install = result.install
    flags.git = result.git
    flags.pm = result.pm
  } catch (error) {
    if (error instanceof WizardCancelledError) cancel()
    throw error
  }
}

if (!flags.name) {
  stdout.write(USAGE)
  process.exit(1)
}

let pm = flags.pm ?? detectPackageManager()
// The web/ frontend is a pnpm workspace member (pnpm-workspace.yaml); npm,
// yarn and bun can't install or run it, so --ui projects are pnpm-only.
if (flags.ui && pm !== 'pnpm') {
  console.log(`Note: --ui projects are pnpm workspaces — using pnpm instead of ${pm}.`)
  pm = 'pnpm'
}

try {
  if (resolvesLatest(flags)) console.log('Resolving the latest published dependency versions…')
  const result = await createProject({
    name: flags.name,
    ...(flags.dir ? { dir: flags.dir } : {}),
    tenancy: flags.tenancy,
    auth: flags.auth,
    billing: flags.billing,
    ui: flags.ui,
    cli: flags.cli,
    mcp: flags.mcp,
    prisma: flags.prisma,
    // New apps get the latest published version of every dependency (with the
    // bundled ranges as an offline fallback); --offline skips the registry.
    resolveLatest: resolvesLatest(flags),
  })
  console.log(`\nCreated ${result.options.name} in ${result.dir}\n`)
  for (const file of result.files) console.log(`  ${file}`)
  if (result.versions) {
    const lines = describeResolution(result.versions)
    if (lines.length > 0) console.log(`\n${lines.join('\n')}`)
  } else {
    console.log('\n--offline: used the dependency ranges bundled with this create-basalt release.')
  }

  const run_ = resolveRunDefaults({
    install: flags.install,
    git: flags.git,
    isTTY: Boolean(stdin.isTTY),
    ci: Boolean(process.env['CI']),
  })
  if (flags.install === undefined && !run_.interactive) {
    console.log('\nSkipping dependency install (CI/non-interactive) — pass --install to force it.')
  }

  if (run_.git) {
    console.log('\nInitializing git repository…')
    const ok =
      (await run('git', ['init', '-q'], result.dir)) &&
      (await run('git', ['add', '-A'], result.dir)) &&
      (await run(
        'git',
        ['commit', '-q', '-m', 'Initial commit from create-basalt'],
        result.dir,
      ))
    console.log(
      ok ? '  git repository initialized.' : '  (skipped — git unavailable or already a repo)',
    )
  }

  if (run_.install) {
    console.log(`\nInstalling dependencies with ${pm}…`)
    const ok = await run(pm, ['install'], result.dir)
    if (!ok) console.log(`  (install failed — run "${pm} install" yourself)`)
  }

  const steps = [`cd ${result.dir}`]
  if (!run_.install) steps.push(`${pm} install`)
  if (flags.prisma) {
    // Nothing boots before the database exists: env.DATABASE_URL is required and
    // the app asserts at boot that it reached the MIGRATED database.
    steps.push(`cp .env.example .env   # then point ${envPrefix(result.options.name)}_DATABASE_URL at your database`)
    steps.push(`${pm} run db:migrate${flags.tenancy ? '   # creates the tables and seeds the demo tenant' : '   # creates the tables'}`)
  }
  steps.push(`${pm} run dev${flags.ui ? '        # API on :3000' : ''}`)
  // `web` is a pnpm workspace member (pnpm-workspace.yaml); `dev:web` runs its
  // dev server through a pnpm filter.
  if (flags.ui) steps.push(`pnpm dev:web        # UI on :5180`)
  console.log(`\nNext steps:\n${steps.map((s) => `  ${s}`).join('\n')}\n`)
  console.log(
    `Later: \`${basaltCommand(pm, 'update')}\` updates the dependencies, \`${basaltCommand(pm, 'add ui|cli|mcp')}\` adds a feature, \`${basaltCommand(pm, 'doctor')}\` checks the project.\n`,
  )
} catch (error) {
  if (error instanceof TargetNotEmptyError) {
    console.error(error.message)
    process.exit(1)
  }
  throw error
}
