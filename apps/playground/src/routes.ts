import { ctx, type Container } from '@basaltkit/core'
import { EVENTS } from '@basaltkit/events'
import { HttpError, route } from '@basaltkit/fastify'
import { z } from 'zod'
import { ProjectCreated, ProjectDeleted, PROJECTS, ProjectSchema } from './domain.js'

/** DI scope of the current request (created by the Fastify adapter). */
const scope = (): Container => ctx().container as Container

export const projectRoutes = [
  route({
    method: 'POST',
    url: '/projects',
    body: z.object({ name: z.string().min(3) }),
    response: { 201: ProjectSchema },
    async handler({ body, reply }) {
      const project = scope().get(PROJECTS).create(body.name)
      await scope().get(EVENTS).emit(ProjectCreated, project)
      return reply.code(201).send(project)
    },
  }),

  route({
    method: 'GET',
    url: '/projects',
    response: { 200: z.array(ProjectSchema) },
    async handler() {
      return scope().get(PROJECTS).list()
    },
  }),

  route({
    method: 'GET',
    url: '/projects/:id',
    params: z.object({ id: z.string() }),
    async handler({ params }) {
      const project = scope().get(PROJECTS).find(params.id)
      if (!project) throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Project not found')
      return project
    },
  }),

  route({
    method: 'DELETE',
    url: '/projects/:id',
    params: z.object({ id: z.string() }),
    async handler({ params, reply }) {
      const project = scope().get(PROJECTS).delete(params.id)
      if (!project) throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Project not found')
      await scope().get(EVENTS).emit(ProjectDeleted, project)
      return reply.code(204).send()
    },
  }),

  route({
    method: 'GET',
    url: '/tenant',
    async handler() {
      const tenant = ctx().tenant
      return tenant ? { id: tenant.id, name: tenant['name'] ?? null } : { id: null }
    },
  }),

  route({
    method: 'GET',
    url: '/health',
    async handler() {
      return { ok: true, requestId: ctx().requestId }
    },
  }),
]
