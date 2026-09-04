/**
 * A tenant that exists for the duration of one test.
 *
 * Every multi-tenant suite writes this by hand, and the hand-written version
 * has a specific failure. Isolation tests need a tenant that is genuinely new,
 * so they drop it first — and reaching for raw SQL to do that
 * (`$executeRawUnsafe('DROP SCHEMA "tenant_' + id + '" CASCADE')`) normalises
 * string interpolation into an SQL identifier, which is safe with a constant id
 * and a habit worth not forming.
 *
 * The worse half is what happens without the cleanup: a schema left behind by a
 * failed run makes the next provisioning a no-op, and every assertion after it
 * passes green against the *previous* run's data. The suite stops testing
 * anything and says nothing.
 */

/** The subset of `Tenancy` this helper needs — structural, so no package dependency. */
export interface TenantLifecycle {
  find(id: string): Promise<unknown | null>
  create(tenant: { id: string } & Record<string, unknown>): Promise<unknown>
  destroy(id: string, options?: { force?: boolean }): Promise<void>
  run<T>(tenantOrId: string, fn: () => T | Promise<T>): Promise<T>
}

export interface WithTenantOptions {
  /** Extra fields for the tenant record — name, plan, domain … */
  fields?: Record<string, unknown>
  /**
   * Whether to remove the tenant afterwards. Default: true.
   *
   * `false` leaves it standing for inspection after a failure — useful once,
   * and a trap if it stays in the file, because the next run inherits it.
   */
  cleanup?: boolean
}

/**
 * Provisions a tenant, runs `fn` inside its context, and removes it afterwards
 * — including when `fn` throws, which is the case that matters. A failing test
 * that leaves its tenant behind makes the *next* run fail for a different
 * reason, and that is a bad hour.
 *
 * ```ts
 * await withTenant(tenancy, 'acme', async () => {
 *   await request('/matters')   // runs with ctx().tenant === acme
 * })
 * ```
 *
 * Any leftover tenant of the same id is destroyed first, with `force`: a
 * previous run may have died between creating the record and provisioning the
 * schema, and refusing to clean that up would mean the suite can never recover
 * on its own.
 */
export async function withTenant<T>(
  tenancy: TenantLifecycle,
  id: string,
  fn: () => T | Promise<T>,
  options: WithTenantOptions = {},
): Promise<T> {
  if ((await tenancy.find(id)) !== null) {
    await tenancy.destroy(id, { force: true })
  }

  await tenancy.create({ id, ...options.fields })
  try {
    return await tenancy.run(id, fn)
  } finally {
    if (options.cleanup !== false) {
      await tenancy.destroy(id, { force: true })
    }
  }
}
