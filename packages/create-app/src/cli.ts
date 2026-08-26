#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { stdin, stdout } from 'node:process'
import {
  createProject,
  detectPackageManager,
  runWizard,
  ttyPrompter,
  TargetNotEmptyError,
  WizardCancelledError,
  type PackageManager,
} from './index.js'

const USAGE = `Usage: npm create basalt <name> [options]

Options:
  --dir=<path>    Target directory (default: ./<name>)
  --no-tenancy    Skip multi-tenancy
  --no-auth       Skip authentication
  --billing       Include subscriptions/billing
  --ui            Scaffold a web/ frontend (React + shadcn + SDK)
  --cli           Scaffold the 'basalt' CLI (code generators + commands)
  --mcp           Expose read-only routes as MCP tools at /mcp
  --install       Install dependencies after scaffolding
  --git           Initialize a git repository with a first commit
  --pm=<manager>  Package manager: pnpm | npm | yarn | bun (default: auto-detect)
  -y, --yes       Skip prompts and accept defaults
  -h, --help      Show this help

Run with no name in a terminal to be prompted interactively.
`

interface Flags {
  name?: string
  dir?: string
  tenancy: boolean
  auth: boolean
  billing: boolean
  ui: boolean
  cli: boolean
  mcp: boolean
  install: boolean
  git: boolean
  yes: boolean
  pm?: PackageManager
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = {
    tenancy: true,
    auth: true,
    billing: false,
    ui: false,
    cli: false,
    mcp: false,
    install: false,
    git: false,
    yes: false,
  }
  for (const token of argv) {
    if (token === '--no-tenancy') flags.tenancy = false
    else if (token === '--no-auth') flags.auth = false
    else if (token === '--billing') flags.billing = true
    else if (token === '--ui') flags.ui = true
    else if (token === '--cli') flags.cli = true
    else if (token === '--mcp') flags.mcp = true
    else if (token === '--install') flags.install = true
    else if (token === '--git') flags.git = true
    else if (token === '-y' || token === '--yes') flags.yes = true
    else if (token.startsWith('--dir=')) flags.dir = token.slice('--dir='.length)
    else if (token.startsWith('--pm=')) flags.pm = token.slice('--pm='.length) as PackageManager
    else if (token === '--help' || token === '-h') {
      stdout.write(USAGE)
      process.exit(0)
    } else if (!token.startsWith('--') && flags.name === undefined) flags.name = token
  }
  return flags
}

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
  const result = await createProject({
    name: flags.name,
    ...(flags.dir ? { dir: flags.dir } : {}),
    tenancy: flags.tenancy,
    auth: flags.auth,
    billing: flags.billing,
    ui: flags.ui,
    cli: flags.cli,
    mcp: flags.mcp,
  })
  console.log(`\nCreated ${result.options.name} in ${result.dir}\n`)
  for (const file of result.files) console.log(`  ${file}`)

  if (flags.git) {
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

  if (flags.install) {
    console.log(`\nInstalling dependencies with ${pm}…`)
    const ok = await run(pm, ['install'], result.dir)
    if (!ok) console.log(`  (install failed — run "${pm} install" yourself)`)
  }

  const steps = [`cd ${result.dir}`]
  if (!flags.install) steps.push(`${pm} install`)
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
