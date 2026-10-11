import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { packageJson, type ProjectOptions } from '../src/templates.js'

/**
 * Every required `@basaltkit/*` peer of a package a new app depends on must be
 * in the app's own manifest. A peer is how a package shares the app's copy of
 * a container token (`AUTH`, `MAILER`, …); a package manager that does not
 * install peers on its own would otherwise leave the scaffold unable to load
 * (or, with a nested copy, silently miss the app's binding).
 */

interface Manifest {
  name: string
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

const packagesDir = fileURLToPath(new URL('../../', import.meta.url))

const workspace = new Map<string, Manifest>()
for (const dir of readdirSync(packagesDir)) {
  const file = join(packagesDir, dir, 'package.json')
  if (!existsSync(file)) continue
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as Manifest
  workspace.set(manifest.name, manifest)
}

/** Required (non-optional) `@basaltkit/*` peers missing from a scaffolded manifest. */
export function missingBasaltPeers(app: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }): string[] {
  const present = { ...app.dependencies, ...app.devDependencies }
  const missing: string[] = []
  for (const name of Object.keys(present)) {
    const manifest = workspace.get(name)
    if (!manifest) continue
    for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
      if (!peer.startsWith('@basaltkit/')) continue
      if (manifest.peerDependenciesMeta?.[peer]?.optional) continue
      if (!(peer in present)) missing.push(`${name} → ${peer}`)
    }
  }
  return missing
}

const FLAGS = ['tenancy', 'auth', 'billing', 'cli', 'mcp', 'prisma'] as const

/** Every combination of the flags that shape the API manifest. */
function combinations(): ProjectOptions[] {
  const out: ProjectOptions[] = []
  for (let mask = 0; mask < 1 << FLAGS.length; mask++) {
    const options: ProjectOptions = { name: 'peers', tenancy: false, auth: false, billing: false, ui: false, cli: false, mcp: false, prisma: false }
    FLAGS.forEach((flag, i) => {
      options[flag] = (mask & (1 << i)) !== 0
    })
    out.push(options)
  }
  return out
}

describe('scaffolded manifests carry the peers of their @basaltkit packages', () => {
  it('reads the workspace manifests', () => {
    expect(workspace.size).toBeGreaterThan(50)
  })

  it.each(combinations().map((options) => [FLAGS.filter((flag) => options[flag]).join('+') || 'minimal', options] as const))(
    '%s',
    (_label, options) => {
      expect(missingBasaltPeers(JSON.parse(packageJson(options)))).toEqual([])
    },
  )

  it('the checker catches a missing peer', () => {
    expect(missingBasaltPeers({ devDependencies: { '@basaltkit/testing': '^3.0.0' } })).toEqual([
      '@basaltkit/testing → @basaltkit/mailer',
    ])
    expect(missingBasaltPeers({ dependencies: { '@basaltkit/auth-prisma': '^3.0.0' } })).toEqual([
      '@basaltkit/auth-prisma → @basaltkit/auth',
    ])
  })
})
