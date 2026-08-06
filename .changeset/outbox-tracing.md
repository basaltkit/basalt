---
"@machize/core": minor
"@machize/events": minor
"@machize/fastify": minor
---

Reliability & tracing:

- `@machize/events`: transactional **outbox** for at-least-once delivery to external systems — `Outbox`, `MemoryOutboxStore`, `outboxPlugin` (capture domain events tenant-scoped, relay on an interval with retry/backoff and a dead-letter ceiling).
- `@machize/core`: dependency-free **distributed tracing** — W3C trace-context (`parseTraceparent`/`formatTraceparent`), `Tracer`/`Span`, and an **OTLP/HTTP JSON exporter** that talks to any OpenTelemetry collector (`OtlpHttpExporter`), plus `ConsoleSpanExporter`/`InMemorySpanExporter`.
- `@machize/fastify`: `tracingPlugin` — continues an inbound trace, records a server span per request (labelled by route template) with HTTP attributes and status, echoes `traceparent`, and exports.
