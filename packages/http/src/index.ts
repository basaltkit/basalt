export {
  route,
  type BasaltRoute,
  type HandlerArgs,
  type HttpMethod,
  type HttpRequest,
  type HttpReply,
} from './route.js'
export {
  GuardsWithoutContainerError,
  HttpError,
  RequestValidationError,
  NOT_FOUND_RESPONSE,
  type ValidationIssue,
} from './errors.js'
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

export { computeEtag, ifNoneMatchSatisfied } from './etag.js'

export {
  sse,
  isSseResponse,
  sseProducerOf,
  encodeSseEvent,
  driveSse,
  SSE_HEADERS,
  type SseEvent,
  type SseStream,
  type SseOptions,
  type SseProducer,
  type SseResponse,
  type SseSink,
} from './sse.js'

export { escapeHtml, scriptJson, pageCsp, cspHash, type PageCspOptions } from './html.js'
export {
  GUARDED_META_BUCKET,
  GUARDED_META_KEYS,
  UnguardedRouteMetaError,
  assertRoutesGuarded,
} from './guarded-meta.js'
