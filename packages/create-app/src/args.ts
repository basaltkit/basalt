import { stdout } from 'node:process'
import type { PackageManager } from './index.js'

export const USAGE = `Usage: npm create basalt <name> [options]

Options:
  --dir=<path>    Target directory (default: ./<name>)
  --no-tenancy    Skip multi-tenancy
  --no-auth       Skip authentication
  --billing       Include subscriptions/billing
  --ui            Scaffold a web/ frontend (React + shadcn + SDK)
  --cli           Scaffold the 'basalt' CLI (code generators + commands)
  --mcp           Expose read-only routes as MCP tools at /mcp
  --prisma, --db  Back the app with PostgreSQL through Prisma: schema,
                  migrations, prisma-backed stores and a boot-time check
                  that the database is the migrated one
  --install       Install dependencies (default: yes in an interactive
                  terminal, skipped in CI/non-TTY; --no-install to opt out)
  --no-install    Never install dependencies
  --git           Initialize a git repository with a first commit
                  (same default rule as --install; --no-git to opt out)
  --no-git        Never initialize a git repository
  --offline       Don't query the npm registry for the latest versions;
                  use the ranges bundled with this create-basalt release
  --pm=<manager>  Package manager: pnpm | npm | yarn | bun (default: auto-detect)
  -y, --yes       Skip prompts and accept defaults
  -h, --help      Show this help

Run with no name in a terminal to be prompted interactively.
`

export interface Flags {
  name?: string
  dir?: string
  tenancy: boolean
  auth: boolean
  billing: boolean
  ui: boolean
  cli: boolean
  mcp: boolean
  prisma: boolean
  /** Tri-state: undefined = decide from the environment (TTY yes, CI no). */
  install?: boolean
  git?: boolean
  yes: boolean
  offline: boolean
  pm?: PackageManager
}

export function parseArgs(argv: string[]): Flags {
  const flags: Flags = {
    tenancy: true,
    auth: true,
    billing: false,
    ui: false,
    cli: false,
    mcp: false,
    prisma: false,
    yes: false,
    offline: false,
  }
  for (const token of argv) {
    if (token === '--no-tenancy') flags.tenancy = false
    else if (token === '--no-auth') flags.auth = false
    else if (token === '--billing') flags.billing = true
    else if (token === '--ui') flags.ui = true
    else if (token === '--cli') flags.cli = true
    else if (token === '--mcp') flags.mcp = true
    // `--db` reads naturally in a sentence ("scaffold it with a db") and is the
    // same switch; the canonical spelling stays the package name, like --mcp.
    else if (token === '--prisma' || token === '--db') flags.prisma = true
    else if (token === '--install') flags.install = true
    else if (token === '--no-install') flags.install = false
    else if (token === '--git') flags.git = true
    else if (token === '--no-git') flags.git = false
    else if (token === '-y' || token === '--yes') flags.yes = true
    else if (token === '--offline') flags.offline = true
    else if (token.startsWith('--dir=')) flags.dir = token.slice('--dir='.length)
    else if (token.startsWith('--pm=')) flags.pm = token.slice('--pm='.length) as PackageManager
    else if (token === '--help' || token === '-h') {
      stdout.write(USAGE)
      process.exit(0)
    } else if (!token.startsWith('--') && flags.name === undefined) flags.name = token
  }
  return flags
}

/** Whether the scaffold should query the registry for the latest versions. */
export const resolvesLatest = (flags: Pick<Flags, 'offline'>): boolean => !flags.offline
