import { ctx, type Container } from '@machize/core'
import { EVENTS } from '@machize/events'
import { HttpError, route } from '@machize/fastify'
import { z } from 'zod'
import { ProjectCreated, ProjectDeleted, PROJECTS, ProjectSchema } from './domain.js'

/** Escopo DI da request atual (criado pelo adaptador Fastify). */
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
      if (!project) throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Projeto não existe')
      return project
    },
  }),

  route({
    method: 'DELETE',
    url: '/projects/:id',
    params: z.object({ id: z.string() }),
    async handler({ params, reply }) {
      const project = scope().get(PROJECTS).delete(params.id)
      if (!project) throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Projeto não existe')
      await scope().get(EVENTS).emit(ProjectDeleted, project)
      return reply.code(204).send()
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
