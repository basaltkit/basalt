export { route, type MachizeRoute, type HandlerArgs, type HttpMethod } from './route.js'
export {
  fastifyPlugin,
  registerRoutes,
  FASTIFY,
  type FastifyPluginOptions,
} from './adapter.js'
export { HttpError, RequestValidationError, type ValidationIssue } from './errors.js'
