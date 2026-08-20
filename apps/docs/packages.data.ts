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

/**
 * Build-time loader: reads every `@basaltkit/*` package's `package.json`, so the
 * Ecosystem page always shows the current versions. `watch` re-runs it in dev
 * when any package.json changes.
 */
export default {
  watch: ['../../packages/*/package.json'],
  load(): EcosystemPackage[] {
    const out: EcosystemPackage[] = []
    for (const dir of readdirSync(packagesDir)) {
      try {
        const pkg = JSON.parse(readFileSync(join(packagesDir, dir, 'package.json'), 'utf8'))
        if (typeof pkg.name === 'string' && pkg.name.startsWith('@basaltkit/') && !pkg.private) {
          out.push({ name: pkg.name, version: String(pkg.version ?? ''), description: String(pkg.description ?? '') })
        }
      } catch {
        // skip a dir without a readable package.json
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  },
}
