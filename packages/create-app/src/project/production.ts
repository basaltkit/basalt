import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DOCKERFILE, DOCKERIGNORE, PRODUCTION_ENTRY } from '../stubs.js'
import { BUILD_SCRIPT, PRISMA_IMPORTS, START_DEV_SCRIPT, START_SCRIPT, tsconfigBuildJson } from '../templates.js'
import { mergePackageJson, type PackageJson } from './package-json.js'

/**
 * The production path (BK-026) for an app scaffolded before create-basalt
 * shipped one: `create-basalt update` OFFERS what is missing — it is part of
 * the printed plan, applied only on confirmation — and never rewrites what the
 * app already has. In particular an existing `start` script is never changed:
 * switching it from tsx to the compiled server changes how the app is
 * deployed, so that is printed as a manual step.
 */

export interface ProductionPathPlan {
  /** New files: path → content (only files that do not exist yet). */
  files: Record<string, string>
  /** package.json after the additions (the input text when nothing changes). */
  packageJsonText: string
  /** One line per change, for the plan's "Project tooling" section. */
  notes: string[]
  /** Steps printed for the user, never applied. */
  manual: string[]
}

/** A Prisma generator that still writes the client under src/ — tsc does not copy its .js files to dist/. */
export const LEGACY_PRISMA_OUTPUT = /generator\s+\w+\s*\{[^}]*output\s*=\s*"\.\.\/src\/[^"]*"/

/** `start` (or any script) that runs TypeScript through tsx. */
export const RUNS_TSX = /(^|[\s;&|])(?:npx\s+|pnpm\s+(?:exec\s+)?)?tsx(\s|$)|--import[= ]tsx\b/

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

const exists = async (path: string): Promise<boolean> => (await readOptional(path)) !== undefined

export const MANUAL_START_SNIPPET = `In package.json, run the compiled server in production (build first: \`pnpm build\`):
  "start": "${START_SCRIPT}",
  "start:dev": "${START_DEV_SCRIPT}"`

export const MANUAL_PRISMA_LAYOUT_SNIPPET = `The Prisma client is generated under src/, where \`tsc\` does not copy its .js files — \`node ${PRODUCTION_ENTRY}\` cannot load it. Move it out of src/:
  prisma/schema.prisma   output = "../generated/prisma"
  package.json           "imports": ${JSON.stringify(PRISMA_IMPORTS)}
  src/db.ts              import { PrismaClient } from '#db/client.js'
  .gitignore             generated/   (instead of src/generated/)
then \`pnpm db:generate\` and delete src/generated/. The Dockerfile is offered once this is done.`

/**
 * What an existing app lacks of the production path: tsconfig.build.json, a
 * `build` script, the Dockerfile and .dockerignore, and — for a Prisma app —
 * a direct `@prisma/client-runtime-utils` dependency. Pure apart from reading
 * the app's files. The Dockerfile is offered to pnpm apps only, and not
 * while the Prisma client is still generated under src/.
 */
export async function planProductionPath(
  dir: string,
  packageJsonText: string,
  pm: string = 'pnpm',
): Promise<ProductionPathPlan> {
  const pkg = JSON.parse(packageJsonText) as PackageJson
  const files: Record<string, string> = {}
  const notes: string[] = []
  const manual: string[] = []

  if (!(await exists(join(dir, 'tsconfig.build.json')))) {
    files['tsconfig.build.json'] = tsconfigBuildJson()
    notes.push('tsconfig.build.json: what `build` compiles (src/ → dist/, rootDir `.`)')
  }

  const schema = await readOptional(join(dir, 'prisma', 'schema.prisma'))
  const prismaClient = pkg.dependencies?.['@prisma/client']
  const merged = mergePackageJson(packageJsonText, {
    scripts: { build: BUILD_SCRIPT },
    ...(schema !== undefined && prismaClient !== undefined
      ? { dependencies: { '@prisma/client-runtime-utils': prismaClient } }
      : {}),
  })
  for (const change of merged.changes) {
    if (change.startsWith('scripts:')) notes.push(`package.json: a "build" script (${BUILD_SCRIPT})`)
    else notes.push(`package.json: @prisma/client-runtime-utils ${prismaClient} — the generated client requires it by name; plain node cannot reach it as a transitive dependency`)
  }

  const start = pkg.scripts?.['start']
  if (start !== undefined && RUNS_TSX.test(start)) manual.push(MANUAL_START_SNIPPET)

  const legacyPrisma = schema !== undefined && LEGACY_PRISMA_OUTPUT.test(schema)
  if (legacyPrisma) manual.push(MANUAL_PRISMA_LAYOUT_SNIPPET)
  // The Dockerfile installs with pnpm (frozen pnpm-lock.yaml): offered to pnpm apps only.
  else if (pm === 'pnpm' && !(await exists(join(dir, 'Dockerfile')))) {
    files['Dockerfile'] = DOCKERFILE
    notes.push(`Dockerfile: build stage + plain-node runtime running ${PRODUCTION_ENTRY} (same as \`basalt publish dockerfile\`)`)
  }
  if (!(await exists(join(dir, '.dockerignore')))) {
    files['.dockerignore'] = DOCKERIGNORE
    notes.push('.dockerignore: keeps .env, keys and node_modules out of the image')
  }

  return { files, packageJsonText: merged.text, notes, manual }
}
