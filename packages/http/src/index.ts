export {
  route,
  type BasaltRoute,
  type RouteMeta,
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
  type HttpErrorOptions,
  type ValidationIssue,
} from './errors.js'
export {
  sanitizeErrorDetails,
  MAX_ERROR_DETAILS_BYTES,
  MAX_ERROR_DETAILS_DEPTH,
  type ErrorDetails,
} from './error-details.js'
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
  DEFAULT_CACHE_CONTROL,
  DEFAULT_RATE_LIMIT_MAX_ENTRIES,
  type MemoryRateLimitStoreOptions,
  type SecurityPluginOptions,
  type RateLimitOptions,
  type RateLimitResult,
  type RateLimitStore,
  type RouteRateLimit,
  type RateLimitKey,
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
  upload,
  isUploadBody,
  uploadOptionsOf,
  type UploadOptions,
  type UploadBody,
  type UploadedFile,
  type ResolvedUploadOptions,
} from './upload.js'
export { sanitizeFilename } from './multipart.js'

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
export { redactUrl, REDACTED } from './redact-url.js'
export {
  reportHttpError,
  httpErrorReporter,
  consoleSink,
  type HttpErrorReport,
  type HttpErrorReporter,
  type HttpLogSink,
} from './error-report.js'
