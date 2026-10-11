import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A package that reads or binds another package's container token must share
 * the app's copy of that package, so it takes it as a PEER, not a plain
 * dependency.
 *
 * A `Token` is `{ key: Symbol(description) }` (`core/src/token.ts`): a module-
 * local symbol. With a plain dependency, an app on another major line of the
 * token's package gets a nested private copy, and `container.get(TOKEN)` /
 * `has(TOKEN)` from that copy never sees the app's binding — a boot failure at
 * best, a silently unwired feature (`has()` → false) at worst. The store
 * drivers (`*-prisma`, `*-sqlite`), `auth-saml`, `billing-ui` and
 * `audit-viewer` already follow this rule; this test keeps it from regressing.
 *
 * `@basaltkit/core` (the container itself) and `@basaltkit/http` (the adapters
 * ARE its runtime, and every dependent moves with an http major — see
 * VERSIONING.md, "majors forced by dependencies") are out of scope.
 */

/**
 * Known couplings that predate the rule. Each moves to a peer at the next
 * major of the DEPENDENT package (a peer changes the install shape); none is
 * split today because the token's package has not left its major line. Do not
 * add entries: take the dependency as a peer instead.
 */
const DEFERRED = new Set([
  '@basaltkit/audit → @basaltkit/events',
  '@basaltkit/webhooks → @basaltkit/events',
  '@basaltkit/backup → @basaltkit/scheduler',
  '@basaltkit/backup → @basaltkit/storage',
  '@basaltkit/files → @basaltkit/storage',
])

const EXEMPT = new Set(['@basaltkit/core', '@basaltkit/http'])
const CONTAINER_CALL = /\.(get|has|register|singleton|scoped|transient)\(\s*([A-Z][A-Z0-9_]*)\b/g
const NAMED_IMPORT = /import\s+\{([^}]*)\}\s+from\s+'(@basaltkit\/[^'/]+)(?:\/[^']*)?'/g

interface ManifestLike {
  name: string
  dependencies?: Record<string, string>
}

/** `dependent → dependency` pairs where a token of a plain dependency reaches the container. */
export function tokenFromPlainDependency(manifest: ManifestLike, sources: string[]): string[] {
  const plain = new Set(Object.keys(manifest.dependencies ?? {}).filter((name) => !EXEMPT.has(name)))
  const found = new Set<string>()
  for (const source of sources) {
    const used = new Set([...source.matchAll(CONTAINER_CALL)].map((match) => match[2]))
    for (const [, names, from] of source.matchAll(NAMED_IMPORT)) {
      if (!plain.has(from!)) continue
      for (const raw of names!.split(',')) {
        const name = raw.trim()
        if (!name || name.startsWith('type ')) continue
        const local = name.split(/\s+as\s+/).pop()!
        if (used.has(local)) found.add(`${manifest.name} → ${from}`)
      }
    }
  }
  return [...found].sort()
}

const packagesDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../packages')

function sourcesOf(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourcesOf(full)
    return /\.tsx?$/.test(entry.name) ? [readFileSync(full, 'utf8')] : []
  })
}

function violations(): string[] {
  return readdirSync(packagesDir).flatMap((dir) => {
    const manifestFile = path.join(packagesDir, dir, 'package.json')
    const src = path.join(packagesDir, dir, 'src')
    if (!existsSync(manifestFile) || !existsSync(src)) return []
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as ManifestLike
    return tokenFromPlainDependency(manifest, sourcesOf(src))
  })
}

describe('container tokens are shared through peers', () => {
  it('no package reads or binds a token of a plain @basaltkit dependency', () => {
    expect(violations().filter((pair) => !DEFERRED.has(pair))).toEqual([])
  })

  it('every deferred entry is still real (drop it once fixed)', () => {
    const current = new Set(violations())
    expect([...DEFERRED].filter((pair) => !current.has(pair))).toEqual([])
  })

  it('the checker catches a token read from a plain dependency', () => {
    const source = "import { AUDIT } from '@basaltkit/audit'\nexport const read = (c) => c.get(AUDIT)"
    expect(tokenFromPlainDependency({ name: 'x', dependencies: { '@basaltkit/audit': 'workspace:^' } }, [source])).toEqual([
      'x → @basaltkit/audit',
    ])
    // A peer is the fix: the checker only looks at plain dependencies.
    expect(tokenFromPlainDependency({ name: 'x', dependencies: {} }, [source])).toEqual([])
    // Binding the token counts too (a fake registered from a private copy is invisible).
    const binds = "import { MAILER } from '@basaltkit/mailer'\ncontainer.singleton(MAILER, () => fake)"
    expect(tokenFromPlainDependency({ name: 'y', dependencies: { '@basaltkit/mailer': 'workspace:^' } }, [binds])).toEqual([
      'y → @basaltkit/mailer',
    ])
  })
})
