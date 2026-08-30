import { readdirSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The SaaS-layer boundary, enforced structurally.
 *
 * The behavioural half of this net lives in `beyond-saas.test.ts`: generic
 * packages must *run* without `tenancyPlugin`. This half enforces the same rule
 * one level up, in the dependency manifests — a generic package must not force
 * the SaaS layer onto its consumers' dependency graph either. A non-SaaS app
 * should not end up with `@basaltkit/tenancy` in `node_modules` because it
 * wanted an audit trail.
 *
 * Modeled on `packages/http/tests/adapter-boundary.test.ts`, which enforces
 * adapter neutrality the same way. Every allowlist entry must be justified.
 */

const SAAS_PACKAGES = ['@basaltkit/tenancy', '@basaltkit/teams', '@basaltkit/subscriptions']

/**
 * Packages allowed to depend on the SaaS layer at runtime. Additions should be
 * rare and reviewed — each one is a package a non-SaaS app cannot install
 * without pulling in tenancy/teams/billing.
 */
const ALLOWLIST = new Set([
  // The SaaS layer itself, and its drivers/UIs. Depending on tenancy/teams/
  // subscriptions is their entire purpose.
  '@basaltkit/tenancy',
  '@basaltkit/tenancy-prisma',
  '@basaltkit/tenancy-sqlite',
  '@basaltkit/teams',
  '@basaltkit/teams-prisma',
  '@basaltkit/teams-sqlite',
  '@basaltkit/teams-ui',
  '@basaltkit/subscriptions',
  '@basaltkit/subscriptions-prisma',
  '@basaltkit/subscriptions-sqlite',
  '@basaltkit/subscriptions-pdf',
  '@basaltkit/subscriptions-appypay',
  '@basaltkit/subscriptions-proxypay',
  '@basaltkit/billing-ui',
  // The dashboard's headline capability is billing metrics (MRR/ARR/churn), so
  // its public types are subscription types. The import is type-only and erased
  // at build (see packages/dashboard/src/metrics.ts), but consumers still need
  // those types to compile against the exported signatures.
  '@basaltkit/dashboard',
  // The batteries-included meta-package and the app scaffolder deliberately
  // ship the full SaaS stack; that is what they are for.
  '@basaltkit/sdk',
  '@basaltkit/create-app',
  // KNOWN COUPLING (not a behavioural leak — see beyond-saas.test.ts, which
  // passes for activity). @basaltkit/activity is generic and fail-open by
  // default, but its opt-in `tenantScoped: 'required'` mode reuses tenancy's
  // `requireTenantId`/`TenantRequiredError` rather than forking them, which
  // would break `instanceof` for anyone catching that error. The dependency is
  // therefore a deliberate trade, revisit if the mode is ever removed or the
  // error is lifted into @basaltkit/core.
  '@basaltkit/activity',
])

/** Manifest fields that force a dependency onto the package's consumers. */
const RUNTIME_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const

interface ManifestLike {
  name: string
  private?: boolean
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

/**
 * Pure checker, so a failure names the package, the field and the SaaS package.
 * Exported for its own unit test below.
 */
export function saasDependencyViolations(manifest: ManifestLike): string[] {
  if (ALLOWLIST.has(manifest.name)) return []
  const violations: string[] = []
  for (const field of RUNTIME_FIELDS) {
    for (const dependency of Object.keys(manifest[field] ?? {})) {
      if (SAAS_PACKAGES.includes(dependency)) {
        violations.push(`${manifest.name} → ${field}.${dependency}`)
      }
    }
  }
  return violations
}

const packagesDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../packages')

function readManifests(): ManifestLike[] {
  return readdirSync(packagesDir)
    .map((dir) => path.join(packagesDir, dir, 'package.json'))
    .filter((file) => existsSync(file))
    .map((file) => JSON.parse(readFileSync(file, 'utf8')) as ManifestLike)
}

describe('the SaaS layer stays opt-in', () => {
  it('finds the workspace packages', () => {
    expect(readManifests().length).toBeGreaterThan(50)
  })

  it('no generic package depends on tenancy/teams/subscriptions at runtime', () => {
    const violations = readManifests().flatMap(saasDependencyViolations)
    expect(violations).toEqual([])
  })

  it('the checker actually catches a violation', () => {
    expect(
      saasDependencyViolations({ name: '@basaltkit/audit', dependencies: { '@basaltkit/tenancy': 'workspace:^' } }),
    ).toEqual(['@basaltkit/audit → dependencies.@basaltkit/tenancy'])
    // devDependencies are fine: test suites legitimately boot a multi-tenant app.
    expect(
      saasDependencyViolations({
        name: '@basaltkit/audit',
        ...({ devDependencies: { '@basaltkit/tenancy': 'workspace:^' } } as object),
      }),
    ).toEqual([])
  })
})
