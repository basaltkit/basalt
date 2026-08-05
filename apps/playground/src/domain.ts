import { randomUUID } from 'node:crypto'
import { createToken } from '@machize/core'
import { defineEvent } from '@machize/events'
import { z } from 'zod'

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
})
export type Project = z.infer<typeof ProjectSchema>

export const ProjectCreated = defineEvent('project.created', ProjectSchema)
export const ProjectDeleted = defineEvent('project.deleted', ProjectSchema)

export class ProjectRepository {
  private readonly projects = new Map<string, Project>()

  create(name: string): Project {
    const project: Project = { id: randomUUID(), name }
    this.projects.set(project.id, project)
    return project
  }

  list(): Project[] {
    return [...this.projects.values()]
  }

  find(id: string): Project | undefined {
    return this.projects.get(id)
  }

  delete(id: string): Project | undefined {
    const project = this.projects.get(id)
    if (project) this.projects.delete(id)
    return project
  }
}

export interface AuditTrail {
  entries: { event: string; payload: unknown }[]
}

export const PROJECTS = createToken<ProjectRepository>('playground:projects')
export const AUDIT = createToken<AuditTrail>('playground:audit')
