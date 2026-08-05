import { randomUUID } from 'node:crypto'
import { createToken, tryCtx } from '@machize/core'
import { defineEvent } from '@machize/events'
import { z } from 'zod'

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
})
export type Project = z.infer<typeof ProjectSchema>

export const ProjectCreated = defineEvent('project.created', ProjectSchema)
export const ProjectDeleted = defineEvent('project.deleted', ProjectSchema)

/**
 * In-memory stand-in for the shared-database tenancy mode: every operation
 * is transparently scoped to ctx().tenant, exactly like a Prisma client
 * extended with @machize/prisma's tenancyExtension() against a real database.
 */
export class ProjectRepository {
  private readonly stores = new Map<string, Map<string, Project>>()

  create(name: string): Project {
    const project: Project = { id: randomUUID(), name }
    this.store().set(project.id, project)
    return project
  }

  list(): Project[] {
    return [...this.store().values()]
  }

  find(id: string): Project | undefined {
    return this.store().get(id)
  }

  delete(id: string): Project | undefined {
    const project = this.store().get(id)
    if (project) this.store().delete(id)
    return project
  }

  /** Data partition of the current tenant ('central' outside a tenant). */
  private store(): Map<string, Project> {
    const scope = tryCtx()?.tenant?.id ?? 'central'
    let store = this.stores.get(scope)
    if (!store) {
      store = new Map()
      this.stores.set(scope, store)
    }
    return store
  }
}

export interface AuditTrail {
  entries: { event: string; payload: unknown; tenantId: string | null }[]
}

export const PROJECTS = createToken<ProjectRepository>('playground:projects')
export const AUDIT = createToken<AuditTrail>('playground:audit')
