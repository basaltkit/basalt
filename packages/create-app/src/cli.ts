#!/usr/bin/env node
import { spawn } from 'node:child_process'
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
import { parseArgs, resolvesLatest, USAGE } from './args.js'

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

/** Cleanly abort on Ctrl+C instead of dumping a Node AbortError stack trace. */
function cancel(): never {
  stdout.write('\nCancelled.\n')
  process.exit(130) // 128 + SIGINT
}

const flags = parseArgs(process.argv.slice(2))

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
  steps.push(`${pm} run dev${flags.ui ? '        # API on :3000' : ''}`)
  // `web` is wired as a pnpm workspace member (pnpm-workspace.yaml), so its dev
  // server is launched with a pnpm filter regardless of the root package manager.
  if (flags.ui) steps.push(`pnpm --filter ${result.options.name}-web dev   # UI on :5180`)
  console.log(`\nNext steps:\n${steps.map((s) => `  ${s}`).join('\n')}\n`)
} catch (error) {
  if (error instanceof TargetNotEmptyError) {
    console.error(error.message)
    process.exit(1)
  }
  throw error
}
