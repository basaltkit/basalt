export { route, type MachizeRoute, type HandlerArgs, type HttpMethod } from './route.js'
export {
  fastifyPlugin,
  registerRoutes,
  FASTIFY,
  type FastifyPluginOptions,
  type RequestEnricher,
  type RouteGuard,
} from './adapter.js'
export { HttpError, RequestValidationError, type ValidationIssue } from './errors.js'
