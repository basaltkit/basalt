import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The driver-agnostic boundary (2026-08).
 *
 * BasaltKit's backend-facing capabilities (queue, cache, storage, mailer,
 * search, …) are *cores* that define a neutral driver contract, with the
 * concrete backends behind it. A core must therefore never force ONE backend's
 * client library onto every consumer: an app running on SQS must not install —
 * let alone load — BullMQ and ioredis.
 *
 * `@basaltkit/queue` shipped exactly that regression: `bullmq` sat in
 * `dependencies` and the barrel statically re-exported `drivers/bullmq.js`,
 * because BullMQ predates the queue-rabbitmq/queue-sqs/queue-kafka satellites
 * and nobody realigned it when they arrived. Nothing caught it — the existing
 * `adapter-boundary`/`saas-boundary` tests only inspect `@basaltkit/*`
 * inter-package edges, never external ones.
 *
 * Two halves, because either alone is defeatable:
 *  1. MANIFEST — a forbidden client in `dependencies`/`optionalDependencies`
 *     (the fields a package manager installs unconditionally into a consumer's
 *     tree). `peerDependencies` is the *sanctioned* form and is deliberately
 *     legal: the consumer opts in, and `peerDependenciesMeta.optional` makes it
 *     opt-in without a warning. This is why `@basaltkit/prisma`
 *     (`@prisma/client`), `@basaltkit/queue-sqs` (`@aws-sdk/client-sqs`),
 *     `@basaltkit/search-postgres` (`pg`) and friends pass without an
 *     allowlist entry — declaring their backend as a peer IS the rule being
 *     followed, not an exception to it. `devDependencies` is legal too (a
 *     driver's own test suite needs the real client).
 *  2. EAGER IMPORT — the package's MAIN entry (`src/index.ts`) must not reach a
 *     forbidden client through a chain of *static* imports. A peer dependency
 *     that the barrel still pulls at module scope is a crash, not a saving:
 *     the manifest says "optional" while `import '@basaltkit/queue'` throws
 *     ERR_MODULE_NOT_FOUND. Driver modules themselves may import their client
 *     statically — they are only reached through `await import()` or a
 *     dedicated subpath entry (`@basaltkit/queue/bullmq`), never from the
 *     barrel. `import type` is erased at build and does not count.
 *
 * Modeled on `packages/http/tests/adapter-boundary.test.ts` (adapter
 * neutrality) and `apps/beyond-saas/tests/saas-boundary.test.ts` (SaaS
 * opt-in) — same shape, same "every allowlist entry must be justified" rule.
 * It lives here because `@basaltkit/queue` owns the canonical core+satellite
 * driver family and is where the class was found; the scan itself is
 * repo-wide and runs on every `turbo run test`.
 */

/**
 * Concrete backend clients: broker/store/provider SDKs that a Basalt driver
 * family wraps. The list is deliberately closed and specific — a heuristic
 * ("anything that looks like a client") would produce false positives on
 * general-purpose libraries (zod, pino, sharp, pdfkit, react) that are not
 * one-of-N backends behind a driver contract.
 */
const BACKEND_CLIENTS = [
  // queue
  'bullmq',
  'amqplib',
  'kafkajs',
  '@aws-sdk/client-sqs',
  // cache
  'ioredis',
  'redis',
  // storage
  '@aws-sdk/client-s3',
  '@aws-sdk/s3-request-presigner',
  '@azure/storage-blob',
  '@google-cloud/storage',
  // mail
  'nodemailer',
  // search
  'meilisearch',
  '@elastic/elasticsearch',
  // persistence
  '@prisma/client',
  'pg',
  'mysql2',
  'mongodb',
  'better-sqlite3',
]

/**
 * Packages allowed a hard dependency on a concrete backend client. Every entry
 * is a package a consumer cannot install without also installing that client,
 * so additions must be rare and argued.
 *
 * All three entries below are the SAME defect as the queue/bullmq one, found
 * by this test when it was written: a driver-agnostic core (`driver.ts` +
 * `drivers/`, with satellite packages alongside) whose default backend is a
 * hard dependency and is re-exported from the barrel. They are frozen here
 * rather than fixed in the same change because each is an independent breaking
 * change for its own package (optional peer + `pnpm add <client>` in the
 * upgrade note) and deserves its own release and docs pass. The remedy is
 * identical to the one applied to queue — see `packages/queue/src/index.ts`.
 */
const ALLOWLIST = new Map<string, string>([
  [
    '@basaltkit/cache',
    "KNOWN DEBT: 'ioredis' is a hard dependency for drivers/redis.ts; the memory " +
      'driver and @basaltkit/cache-tiered consumers pay for it. Make it an optional peer.',
  ],
  [
    '@basaltkit/storage',
    "KNOWN DEBT: '@aws-sdk/client-s3' + presigner are hard dependencies for " +
      'drivers/s3.ts; the local driver and the azure/gcs satellite users pay for it. ' +
      'Make them optional peers.',
  ],
  [
    '@basaltkit/mailer',
    "KNOWN DEBT: 'nodemailer' is a hard dependency for drivers/smtp.ts; the log/" +
      'memory/resend/mailgun/ses drivers pay for it. Make it an optional peer.',
  ],
])

/** Manifest fields a package manager installs into every consumer's tree. */
const FORCED_FIELDS = ['dependencies', 'optionalDependencies'] as const

export interface ManifestLike {
  name: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

/** Pure checker for half 1, so a failure names the package, the field and the client. */
export function forcedClientViolations(
  manifests: ManifestLike[],
  forbidden: string[] = BACKEND_CLIENTS,
  allowlist: ReadonlyMap<string, string> = ALLOWLIST,
): string[] {
  const out: string[] = []
  for (const manifest of manifests) {
    if (allowlist.has(manifest.name)) continue
    for (const field of FORCED_FIELDS) {
      for (const dependency of Object.keys(manifest[field] ?? {})) {
        if (forbidden.includes(dependency)) out.push(`${manifest.name} → ${field} → ${dependency}`)
      }
    }
  }
  return out
}

/**
 * Strip comments and template-literal bodies, keeping ordinary quoted strings
 * (they carry the import specifiers). Same intent as the adapter-boundary
 * test's stripper, kept local so this rule has no cross-package test import.
 */
export function stripNonCode(source: string): string {
  let out = ''
  let i = 0
  const n = source.length
  while (i < n) {
    const c = source[i]!
    const next = source[i + 1]
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1
    } else if (c === '/' && next === '*') {
      i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i += 2
    } else if (c === "'" || c === '"') {
      out += c
      i += 1
      while (i < n && source[i] !== c) {
        if (source[i] === '\\') {
          out += source[i]! + (source[i + 1] ?? '')
          i += 2
        } else {
          out += source[i]!
          i += 1
        }
      }
      out += c
      i += 1
    } else if (c === '`') {
      // Skip the whole template literal (codegen templates embed import lines).
      i += 1
      while (i < n && source[i] !== '`') i += source[i] === '\\' ? 2 : 1
      i += 1
    } else {
      out += c
      i += 1
    }
  }
  return out
}

/**
 * Specifiers a module pulls at LOAD time: static `import`/`export … from`, and
 * bare side-effect `import '…'`. Deliberately excludes `import type` /
 * `export type` (erased at build) and `await import()` (the lazy form this
 * rule exists to encourage).
 */
export function staticSpecifiersOf(source: string): string[] {
  const code = stripNonCode(source)
  const out: string[] = []
  for (const m of code.matchAll(/\b(?:import|export)\s+([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    if (/^type\b/.test(m[1]!.trim())) continue
    out.push(m[2]!)
  }
  for (const m of code.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) out.push(m[1]!)
  return out
}

/** Resolve a relative TS specifier ('./drivers/bullmq.js') to a real source file. */
function resolveRelative(fromFile: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(fromFile), specifier)
  const candidates = [
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    base,
    `${base}.ts`,
    path.join(base, 'index.ts'),
  ]
  return candidates.find((candidate) => existsSync(candidate) && candidate.endsWith('.ts'))
}

/**
 * Half 2: walk the static import graph from a package's main entry and report
 * every forbidden client it reaches, with the chain that reaches it.
 */
export function eagerClientImports(
  packageName: string,
  entry: string,
  forbidden: string[] = BACKEND_CLIENTS,
  allowlist: ReadonlyMap<string, string> = ALLOWLIST,
): string[] {
  if (allowlist.has(packageName) || !existsSync(entry)) return []
  const out: string[] = []
  const seen = new Set<string>()
  const walk = (file: string, chain: string[]): void => {
    if (seen.has(file)) return
    seen.add(file)
    for (const specifier of staticSpecifiersOf(readFileSync(file, 'utf8'))) {
      if (forbidden.includes(specifier)) {
        out.push(`${packageName} → ${[...chain, specifier].join(' → ')}`)
      } else if (specifier.startsWith('.')) {
        const next = resolveRelative(file, specifier)
        if (next) walk(next, [...chain, path.basename(next)])
      }
    }
  }
  walk(entry, [path.basename(entry)])
  return out
}

const packagesDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

function repoPackages(): { manifest: ManifestLike; dir: string }[] {
  const out: { manifest: ManifestLike; dir: string }[] = []
  for (const entry of readdirSync(packagesDir)) {
    const manifestPath = path.join(packagesDir, entry, 'package.json')
    if (!existsSync(manifestPath)) continue
    out.push({
      manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) as ManifestLike,
      dir: path.join(packagesDir, entry),
    })
  }
  return out
}

describe('driver-agnostic boundary', () => {
  it('scans the real monorepo (sanity: the rule is exercised on real packages)', () => {
    const packages = repoPackages()
    expect(packages.length).toBeGreaterThan(50)
    expect(packages.some(({ manifest }) => manifest.name === '@basaltkit/queue')).toBe(true)
  })

  it('no package forces a concrete backend client onto its consumers', () => {
    expect(forcedClientViolations(repoPackages().map(({ manifest }) => manifest))).toEqual([])
  })

  it("no package's main entry statically reaches a concrete backend client", () => {
    const violations = repoPackages().flatMap(({ manifest, dir }) =>
      eagerClientImports(manifest.name, path.join(dir, 'src', 'index.ts')),
    )
    expect(violations).toEqual([])
  })

  it('@basaltkit/queue declares bullmq as an OPTIONAL peer (the shape this rule wants)', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(packagesDir, 'queue', 'package.json'), 'utf8'),
    ) as ManifestLike & { peerDependenciesMeta?: Record<string, { optional?: boolean }> }
    expect(manifest.dependencies?.['bullmq']).toBeUndefined()
    expect(manifest.peerDependencies?.['bullmq']).toBeDefined()
    expect(manifest.peerDependenciesMeta?.['bullmq']?.optional).toBe(true)
    // devDependency kept so this package's own suite can exercise the driver.
    expect(manifest.devDependencies?.['bullmq']).toBeDefined()
  })

  // Negative assertions: prove the checkers fire, so a green run above means
  // something. Same red-proof discipline as the adapter-boundary test.
  it('flags a synthetic forced dependency, but not a peer or a devDependency', () => {
    expect(
      forcedClientViolations([{ name: '@basaltkit/example', dependencies: { bullmq: '^6.0.0' } }]),
    ).toEqual(['@basaltkit/example → dependencies → bullmq'])
    expect(
      forcedClientViolations([
        { name: '@basaltkit/example', optionalDependencies: { ioredis: '^6.0.0' } },
      ]),
    ).toEqual(['@basaltkit/example → optionalDependencies → ioredis'])
    expect(
      forcedClientViolations([
        { name: '@basaltkit/example', peerDependencies: { bullmq: '^6.0.0' } },
      ]),
    ).toEqual([])
    expect(
      forcedClientViolations([
        { name: '@basaltkit/example', devDependencies: { bullmq: '^6.0.0' } },
      ]),
    ).toEqual([])
  })

  it('allowlisted packages are exempt, and every entry carries a justification', () => {
    expect(
      forcedClientViolations([{ name: '@basaltkit/cache', dependencies: { ioredis: '^6.0.0' } }]),
    ).toEqual([])
    for (const [name, reason] of ALLOWLIST) {
      expect(reason.length, `allowlist entry ${name} must justify itself`).toBeGreaterThan(40)
    }
  })

  it('distinguishes a load-time import from a type-only or dynamic one', () => {
    expect(staticSpecifiersOf(`import { Queue } from 'bullmq'`)).toEqual(['bullmq'])
    expect(staticSpecifiersOf(`import 'bullmq'`)).toEqual(['bullmq'])
    expect(staticSpecifiersOf(`export { Queue } from 'bullmq'`)).toEqual(['bullmq'])
    // Erased at build — a type reference costs a consumer nothing at runtime.
    expect(staticSpecifiersOf(`import type { ConnectionOptions } from 'bullmq'`)).toEqual([])
    expect(staticSpecifiersOf(`export type { JobsOptions } from 'bullmq'`)).toEqual([])
    // The lazy form this rule exists to encourage.
    expect(staticSpecifiersOf(`const m = await import('bullmq')`)).toEqual([])
    // Codegen templates and comments are not real imports.
    expect(staticSpecifiersOf("const t = `import { Queue } from 'bullmq'`")).toEqual([])
    expect(staticSpecifiersOf(`// import { Queue } from 'bullmq'`)).toEqual([])
  })

  it('follows a relative chain from the entry (proof the graph walk works)', () => {
    // queue's own driver module DOES import bullmq statically — legal, because
    // the barrel only reaches it lazily. Point the walk straight at it to show
    // the walker sees such an import when it is actually reachable.
    const driverEntry = path.join(packagesDir, 'queue', 'src', 'drivers', 'bullmq.ts')
    expect(eagerClientImports('@basaltkit/synthetic', driverEntry)).toEqual([
      '@basaltkit/synthetic → bullmq.ts → bullmq',
    ])
  })
})
