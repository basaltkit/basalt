import { hashContent } from './project/manifest.js'
import { devTs, ENV_EXAMPLE_LEAD, LEGACY_ENV_EXAMPLE_LEAD } from './templates.js'

/**
 * `src/dev.ts` (the `pnpm dev` entrypoint) and the `.env.example` header across
 * create-basalt releases. Up to 1.10, nothing loaded `.env`: `pnpm dev` booted
 * without the variables the example told you to set. `update` brings untouched
 * copies to the current templates; customised ones get the snippet instead.
 */

/** Hashes of every src/dev.ts an earlier create-basalt release generated (CRLF-insensitive). */
export const LEGACY_DEV_HASHES: ReadonlySet<string> = new Set([
  // 2026-09-19 → create-basalt 1.10: NODE_ENV defaulted, no .env loading.
  'sha256-f25f09fed1b36281a806e29f5aab139a1dda0c5fa898f7c4c71b6ac294326cb7',
])

/** Marker proving a src/dev.ts already loads .env. */
export const DEV_ENV_MARKER = 'process.loadEnvFile('

export type DevEntryStatus = 'current' | 'patchable' | 'modified' | 'absent'

/** Where a src/dev.ts stands: loads .env already, an untouched old template, or user code. */
export function devEntryStatus(content: string | undefined, manifestHash?: string): DevEntryStatus {
  if (content === undefined) return 'absent'
  if (content.includes(DEV_ENV_MARKER)) return 'current'
  const hash = hashContent(content)
  return LEGACY_DEV_HASHES.has(hash) || hash === manifestHash ? 'patchable' : 'modified'
}

/** The current src/dev.ts — what a patchable one becomes. */
export const patchDevEntry = (): string => devTs()

/** What to paste by hand into a customised src/dev.ts. */
export const MANUAL_DEV_SNIPPET = `Paste this at the top of src/dev.ts, BEFORE the server is imported (keep that
import dynamic — \`await import('./server.js')\` — so the variables are set first):

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Development loads .env (when present) like \`node --env-file=.env\`: a variable
// already exported in your shell still wins, the file only fills in what is missing.
const envFile = fileURLToPath(new URL('../.env', import.meta.url))
if (existsSync(envFile)) process.loadEnvFile(envFile)
`

/**
 * `.env.example` with the old "nothing loads this file" lead swapped for the
 * current one; undefined when the file does not start with the old lead (a
 * newer or hand-written file is left alone — it is only comments).
 */
export function patchEnvExample(content: string): string | undefined {
  const normalized = content.replace(/\r\n/g, '\n')
  if (!normalized.startsWith(`${LEGACY_ENV_EXAMPLE_LEAD}\n`)) return undefined
  return `${ENV_EXAMPLE_LEAD}${normalized.slice(LEGACY_ENV_EXAMPLE_LEAD.length)}`
}
