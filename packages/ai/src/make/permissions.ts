import { names } from '@basaltkit/generator'

/**
 * The RBAC permissions for a resource — the exact `<plural>.<action>` strings its
 * route guards check on (F5 derives guards from the entity name, so declaring
 * them here keeps a single source of truth that can't drift from the guards).
 */
export function permissionList(name: string): string[] {
  const prefix = names(name).pluralKebab
  return ['view', 'create', 'update', 'delete'].map((action) => `${prefix}.${action}`)
}

/**
 * Generate `<kebab>.permissions.ts`: the permission constants plus a
 * `grant<Name>Permissions(store, role)` helper — so registering RBAC for the
 * resource is one call in the app's seed/setup, closing the loop F4 opened
 * (guards without a way to grant them).
 */
export function renderPermissionsFile(name: string): string {
  const n = names(name)
  const listLines = permissionList(name)
    .map((p) => `  '${p}',`)
    .join('\n')
  return `import { GLOBAL_SCOPE, type AccessStore } from '@basaltkit/permissions'

/** RBAC permissions for the ${n.pascal} resource — the ones its routes guard on. */
export const ${n.constant}_PERMISSIONS = [
${listLines}
] as const

/** Grant every ${n.pascal} permission to a role (default scope: global). */
export async function grant${n.pascal}Permissions(
  store: AccessStore,
  role: string,
  scope: string = GLOBAL_SCOPE,
): Promise<void> {
  await store.grantToRole(role, [...${n.constant}_PERMISSIONS], scope)
}
`
}
