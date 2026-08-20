import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const docsRoot = dirname(fileURLToPath(import.meta.url))
const packagesDir = join(docsRoot, '../../packages')

export interface EcosystemPackage {
  name: string
  version: string
  description: string
}
export interface EcosystemGroup {
  key: string
  packages: EcosystemPackage[]
}

// Ordered categories. A package is placed in the FIRST group whose base name it
// matches (exactly, or as a `<base>-<variant>` like auth-prisma). Localised
// titles live in the page (keyed by `key`), so this loader stays neutral.
const CATEGORIES: { key: string; bases: string[] }[] = [
  { key: 'foundation', bases: ['core', 'config', 'env', 'events', 'logger'] },
  { key: 'http', bases: ['http', 'fastify', 'express', 'hono', 'sdk'] },
  { key: 'data', bases: ['prisma', 'cache', 'storage', 'files'] },
  { key: 'queues', bases: ['queue', 'scheduler'] },
  { key: 'auth', bases: ['auth', 'permissions', 'api-keys-ui'] },
  { key: 'tenancy', bases: ['tenancy', 'teams'] },
  { key: 'billing', bases: ['subscriptions', 'billing-ui'] },
  { key: 'search', bases: ['search'] },
  { key: 'capabilities', bases: ['realtime', 'notifications', 'mailer', 'comments', 'webhooks', 'activity', 'audit', 'i18n', 'exports', 'flags'] },
  { key: 'admin', bases: ['admin', 'dashboard'] },
  { key: 'devx', bases: ['cli', 'generator', 'ai', 'testing'] },
]

const keyOf = (base: string): string => {
  for (const c of CATEGORIES) {
    if (c.bases.some((b) => base === b || base.startsWith(`${b}-`))) return c.key
  }
  return 'other'
}

/**
 * Build-time loader: reads every `@basaltkit/*` package's `package.json`, groups
 * them by category, and returns the groups in a fixed order. Runs again in dev
 * when any package.json changes.
 */
export default {
  watch: ['../../packages/*/package.json'],
  load(): EcosystemGroup[] {
    const buckets = new Map<string, EcosystemPackage[]>()
    for (const dir of readdirSync(packagesDir)) {
      try {
        const pkg = JSON.parse(readFileSync(join(packagesDir, dir, 'package.json'), 'utf8'))
        if (typeof pkg.name !== 'string' || !pkg.name.startsWith('@basaltkit/') || pkg.private) continue
        const key = keyOf(pkg.name.replace('@basaltkit/', ''))
        const list = buckets.get(key) ?? buckets.set(key, []).get(key)!
        list.push({ name: pkg.name, version: String(pkg.version ?? ''), description: String(pkg.description ?? '') })
      } catch {
        // skip a dir without a readable package.json
      }
    }
    const order = [...CATEGORIES.map((c) => c.key), 'other']
    return order
      .filter((k) => buckets.has(k))
      .map((k) => ({ key: k, packages: buckets.get(k)!.sort((a, b) => a.name.localeCompare(b.name)) }))
  },
}
