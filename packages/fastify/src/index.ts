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
export {
  securityPlugin,
  MemoryRateLimitStore,
  type SecurityPluginOptions,
  type RateLimitOptions,
  type RateLimitResult,
  type RateLimitStore,
  type CorsOptions,
  type SecurityHeadersOptions,
} from './security.js'
export { healthPlugin, type HealthPluginOptions, type HealthCheck, type HealthReport } from './health.js'
