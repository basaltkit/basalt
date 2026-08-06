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
export { metricsPlugin, METRICS, type MetricsPluginOptions } from './metrics.js'
export {
  openapiPlugin,
  generateOpenApi,
  zodToJsonSchema,
  type OpenApiPluginOptions,
  type OpenApiInfo,
  type RouteLike,
} from './openapi.js'
export {
  idempotencyPlugin,
  MemoryIdempotencyStore,
  type IdempotencyPluginOptions,
  type IdempotencyStore,
  type IdempotencyRecord,
} from './idempotency.js'
