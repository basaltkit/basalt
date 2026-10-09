import { DB_SEED_SCRIPT } from '../templates.js'
import type { PackageJson } from './package-json.js'

/**
 * The `db:seed` script create-basalt 1.8.0–1.11.0 generated for `--prisma`
 * apps: `tsx prisma/seed.ts` loads no .env, so on a fresh app it fails in
 * src/env.ts (`ENV_INVALID`: database URL / app secret missing) unless the
 * variables are exported. `prisma db seed` goes through prisma.config.ts,
 * which loads .env and runs the `migrations.seed` command it declares.
 *
 * Only the exact old template is matched: a customised script is the app's.
 * Nothing here rewrites package.json — `doctor` reports it and `update`
 * prints the replacement.
 */
export const LEGACY_DB_SEED = /^\s*tsx\s+(?:\.\/)?prisma\/seed\.ts\s*$/

/** Whether prisma.config.ts declares a seed command (`migrations: { seed: … }`). */
const DECLARES_SEED = /migrations\s*:\s*\{[^}]*\bseed\s*:/

/**
 * The fix for an old `db:seed` script, as printed lines; undefined when the
 * app does not have the old script (or no prisma.config.ts to load .env).
 */
export function legacySeedScriptFix(pkg: PackageJson, prismaConfig: string | undefined): string | undefined {
  const script = pkg.scripts?.['db:seed']
  if (script === undefined || prismaConfig === undefined || !LEGACY_DB_SEED.test(script)) return undefined
  const lines = [
    `\`db:seed\` runs "${script}", which does not load .env — it fails with ENV_INVALID unless the variables are exported. Run it through Prisma (prisma.config.ts loads .env):`,
    `  package.json       "db:seed": "${DB_SEED_SCRIPT}"`,
  ]
  if (!DECLARES_SEED.test(prismaConfig)) {
    lines.push(`  prisma.config.ts   migrations: { seed: '${script.trim()}' },   (inside defineConfig)`)
  }
  return lines.join('\n')
}
