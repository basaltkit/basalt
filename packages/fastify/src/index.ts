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
  type OpenApiTag,
  type RouteLike,
  type HttpServer,
} from '@basaltkit/http'

// Idempotency is framework-neutral since it moved into the shared route
// pipeline (@basaltkit/http); re-exported so existing imports keep working.
export {
  idempotencyPlugin,
  MemoryIdempotencyStore,
  RedisIdempotencyStore,
  DEFAULT_IDEMPOTENCY_CREDENTIAL_HEADERS,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  type MemoryIdempotencyStoreOptions,
  type IdempotencyPluginOptions,
  type IdempotencyStore,
  type IdempotencyRecord,
  type IdempotencyPending,
  type IdempotencyFingerprintInput,
  type RedisIdempotencyStoreOptions,
  /** @deprecated Import `RedisIdempotencyClient` from `@basaltkit/http`. */
  type RedisIdempotencyClient as RedisLike,
} from '@basaltkit/http'
