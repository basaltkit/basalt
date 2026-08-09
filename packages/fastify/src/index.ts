export {
  route,
  type BasaltRoute,
  type HandlerArgs,
  type HttpMethod,
  type HttpRequest,
  type HttpReply,
} from './route.js'
export {
  fastifyPlugin,
  registerRoutes,
  FASTIFY,
  type FastifyPluginOptions,
  type RequestEnricher,
  type RouteGuard,
} from './adapter.js'
export { HttpError, RequestValidationError, type ValidationIssue } from './errors.js'

// The edge plugins are framework-neutral (see @basaltkit/http); re-exported so
// `import { securityPlugin } from '@basaltkit/fastify'` keeps working.
export {
  securityPlugin,
  MemoryRateLimitStore,
  healthPlugin,
  metricsPlugin,
  METRICS,
  tracingPlugin,
  TRACER,
  openapiPlugin,
  generateOpenApi,
  zodToJsonSchema,
  HTTP_SERVER,
  type SecurityPluginOptions,
  type RateLimitOptions,
  type RateLimitResult,
  type RateLimitStore,
  type CorsOptions,
  type SecurityHeadersOptions,
  type HealthPluginOptions,
  type HealthCheck,
  type HealthReport,
  type MetricsPluginOptions,
  type TracingPluginOptions,
  type OpenApiPluginOptions,
  type OpenApiInfo,
  type RouteLike,
  type HttpServer,
} from '@basaltkit/http'

// Idempotency needs to capture the response body, which is Fastify-specific.
export {
  idempotencyPlugin,
  MemoryIdempotencyStore,
  type IdempotencyPluginOptions,
  type IdempotencyStore,
  type IdempotencyRecord,
} from './idempotency.js'
export {
  RedisIdempotencyStore,
  type RedisLike,
  type RedisIdempotencyStoreOptions,
} from './drivers/redis-idempotency.js'
