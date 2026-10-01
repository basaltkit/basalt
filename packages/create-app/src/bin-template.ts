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

/** Marker proving a bin/basalt.ts already delegates the project commands. */
export const PROJECT_COMMANDS_MARKER = "['update', 'add', 'doctor', 'info'].includes(process.argv[2]"

export function basaltBin(): string {
  return `#!/usr/bin/env node
${PRELUDE}
// The dev tools are imported dynamically, after the project commands above.
const { runCli } = await import('@basaltkit/cli')
const { generatorCommands } = await import('@basaltkit/generator')
const { prismaSyncCommand } = await import('@basaltkit/prisma')

// Dev tooling: opt into development defaults unless NODE_ENV is already set
// (imported dynamically below so env.ts is evaluated after this line).
process.env['NODE_ENV'] ??= 'development'
const { buildApp } = await import('../src/app.js')

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
process.exit(await runCli({ app }))
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
])

export const hasProjectCommands = (content: string): boolean => content.includes(PROJECT_COMMANDS_MARKER)

/**
 * Upgrades a template-generated bin/basalt.ts to delegate the project
 * commands: inserts the prelude after the shebang and turns the remaining
 * static imports into dynamic ones (so they no longer run before it).
 * Deterministic for the known templates — for the latest one the result is
 * exactly {@link basaltBin}.
 */
export function patchBasaltBin(content: string): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
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

export type BinStatus = 'current' | 'patchable' | 'modified' | 'absent'

/** Where a bin/basalt.ts stands: already delegating, an untouched old template, or user code. */
export function binStatus(content: string | undefined, manifestHash?: string): BinStatus {
  if (content === undefined) return 'absent'
  if (hasProjectCommands(content)) return 'current'
  const hash = hashContent(content)
  return LEGACY_BIN_HASHES.has(hash) || hash === manifestHash ? 'patchable' : 'modified'
}

/** What to paste by hand into a customised bin/basalt.ts. */
export const MANUAL_BIN_SNIPPET = `Paste this right after the shebang line of bin/basalt.ts, then turn its
static imports of @basaltkit/* and ../src/app.js into dynamic ones
(\`import { runCli } from '@basaltkit/cli'\` → \`const { runCli } = await import('@basaltkit/cli')\`)
so they no longer run before it:

${PRELUDE}`
