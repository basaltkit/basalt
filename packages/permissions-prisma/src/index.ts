import type { AccessStore } from '@basaltkit/permissions'

/**
 * Prisma-backed implementation of the `@basaltkit/permissions` `AccessStore` for
 * production databases (PostgreSQL, MySQL, …). Bring your generated
 * `PrismaClient` with the `PermUserRole`, `PermUserPermission` and
 * `PermRolePermission` models (see the bundled `prisma/schema.prisma`).
 *
 * Role assignments and permission grants are sets — every write is a
 * `createMany({ skipDuplicates: true })`, so re-granting is a harmless no-op.
 * The production counterpart to `@basaltkit/permissions-sqlite`.
 */

/**
 * The minimal Prisma delegate surface the store calls — a real `PrismaClient`
 * with these models is assignable, so pass it directly. Method arguments are
 * typed `any` (Prisma's generated method generics can't be reproduced by a
 * hand-written interface); return types stay precise.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PrismaPermissionsClient {
  permUserRole: {
    findMany(a: any): Promise<{ role: string }[]>
    createMany(a: any): Promise<{ count: number }>
    deleteMany(a: any): Promise<{ count: number }>
  }
  permUserPermission: {
    findMany(a: any): Promise<{ permission: string }[]>
    createMany(a: any): Promise<{ count: number }>
  }
  permRolePermission: {
    findMany(a: any): Promise<{ permission: string }[]>
    createMany(a: any): Promise<{ count: number }>
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export class PrismaAccessStore implements AccessStore {
  constructor(private readonly client: PrismaPermissionsClient) {}

  async getUserRoles(userId: string, scope: string): Promise<string[]> {
    const rows = await this.client.permUserRole.findMany({ where: { scope, userId } })
    return rows.map((r) => r.role)
  }

  async getUserPermissions(userId: string, scope: string): Promise<string[]> {
    const rows = await this.client.permUserPermission.findMany({ where: { scope, userId } })
    return rows.map((r) => r.permission)
  }

  async getRolePermissions(role: string, scope: string): Promise<string[]> {
    const rows = await this.client.permRolePermission.findMany({ where: { scope, role } })
    return rows.map((r) => r.permission)
  }

  async assignRole(userId: string, role: string, scope: string): Promise<void> {
    await this.client.permUserRole.createMany({ data: [{ scope, userId, role }], skipDuplicates: true })
  }

  async removeRole(userId: string, role: string, scope: string): Promise<void> {
    await this.client.permUserRole.deleteMany({ where: { scope, userId, role } })
  }

  async grantToRole(role: string, permissions: string[], scope: string): Promise<void> {
    await this.client.permRolePermission.createMany({
      data: permissions.map((permission) => ({ scope, role, permission })),
      skipDuplicates: true,
    })
  }

  async grantToUser(userId: string, permissions: string[], scope: string): Promise<void> {
    await this.client.permUserPermission.createMany({
      data: permissions.map((permission) => ({ scope, userId, permission })),
      skipDuplicates: true,
    })
  }
}

export interface PrismaPermissionsStores {
  store: PrismaAccessStore
}

/**
 * Wire the access store to your Prisma client, named to drop straight into
 * `permissionsPlugin`:
 *
 * ```ts
 * const p = prismaAccessStore(prisma)
 * permissionsPlugin({ store: p.store })
 * ```
 */
// Fail fast with an actionable message when the Prisma client lacks the models
// this package needs (the alternative is a cryptic "reading 'create' of undefined").
function ensureModel(client: unknown, delegate: string, pkg: string): void {
  let value: unknown
  try {
    value = (client as Record<string, unknown>)[delegate]
  } catch {
    return // lazy/proxy client (e.g. database-per-tenant) — validated at first use
  }
  if (value == null) {
    throw new Error(
      `${pkg}: the Prisma client has no \`${delegate}\` model. Add its models to your ` +
        `schema.prisma (run \`basalt prisma:sync\`, or copy from '${pkg}/schema.prisma'), then \`prisma generate\`.`,
    )
  }
}

export function prismaAccessStore(client: PrismaPermissionsClient): PrismaPermissionsStores {
  ensureModel(client, 'permUserRole', '@basaltkit/permissions-prisma')
  return { store: new PrismaAccessStore(client) }
}
