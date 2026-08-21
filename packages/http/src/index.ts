export {
  route,
  type BasaltRoute,
  type HandlerArgs,
  type HttpMethod,
  type HttpRequest,
  type HttpReply,
} from './route.js'
export { HttpError, RequestValidationError, type ValidationIssue } from './errors.js'
export {
  runRoute,
  toErrorResponse,
  type RequestEnricher,
  type RouteGuard,
  type RoutePipeline,
  type ErrorResponse,
} from './pipeline.js'
export {
  HTTP_SERVER,
  HttpServerCollector,
  type HttpServer,
  type PreHook,
  type AfterHook,
  type SimpleHandler,
} from './server.js'

// Framework-neutral edge plugins — run on any adapter (Fastify/Express/Hono).
export { healthPlugin, type HealthPluginOptions, type HealthCheck, type HealthReport } from './health.js'
export {
  securityPlugin,
  MemoryRateLimitStore,
  DEFAULT_CSP,
  type SecurityPluginOptions,
  type RateLimitOptions,
  type RateLimitResult,
  type RateLimitStore,
  type RouteRateLimit,
  type CorsOptions,
  type SecurityHeadersOptions,
} from './security.js'
export {
  RedisRateLimitStore,
  type RedisLike,
  type RedisRateLimitStoreOptions,
} from './drivers/redis-rate-limit.js'
export { metricsPlugin, METRICS, type MetricsPluginOptions } from './metrics.js'
export { tracingPlugin, TRACER, type TracingPluginOptions } from './tracing.js'
export {
  openapiPlugin,
  generateOpenApi,
  zodToJsonSchema,
  type OpenApiPluginOptions,
  type OpenApiInfo,
  type OpenApiTag,
  type RouteLike,
} from './openapi.js'
