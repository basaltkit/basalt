import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'

/**
 * Minimal, dependency-free distributed tracing: W3C trace-context propagation,
 * spans, and an OTLP/HTTP exporter that speaks to any OpenTelemetry collector.
 * Compatible with the wider ecosystem without pulling the OTel SDK.
 */

export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer'
export type SpanStatus = 'unset' | 'ok' | 'error'
export type AttributeValue = string | number | boolean

export interface SpanContext {
  traceId: string
  spanId: string
  /** W3C trace flags; bit 0 = sampled. */
  traceFlags: number
}

export interface FinishedSpan {
  name: string
  kind: SpanKind
  context: SpanContext
  parentSpanId?: string
  startTime: number
  endTime: number
  attributes: Record<string, AttributeValue>
  status: SpanStatus
  statusMessage?: string
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/

/** Parses a W3C `traceparent` header. */
export function parseTraceparent(header: string | undefined): SpanContext | null {
  if (!header) return null
  const match = TRACEPARENT.exec(header.trim())
  if (!match) return null
  return { traceId: match[1]!, spanId: match[2]!, traceFlags: parseInt(match[3]!, 16) }
}

/** Formats a W3C `traceparent` header. */
export function formatTraceparent(context: SpanContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.traceFlags.toString(16).padStart(2, '0')}`
}

export interface SpanExporter {
  export(spans: FinishedSpan[]): void | Promise<void>
  forceFlush?(): Promise<void>
}

/** Collects spans in memory — for tests and debugging. */
export class InMemorySpanExporter implements SpanExporter {
  readonly spans: FinishedSpan[] = []
  export(spans: FinishedSpan[]): void {
    this.spans.push(...spans)
  }
}

/** Prints a one-line summary per span — for local development. */
export class ConsoleSpanExporter implements SpanExporter {
  constructor(private readonly log: (message: string) => void = console.log) {}
  export(spans: FinishedSpan[]): void {
    for (const span of spans) {
      const ms = span.endTime - span.startTime
      this.log(`[trace] ${span.name} ${ms}ms ${span.status} trace=${span.context.traceId}`)
    }
  }
}

export class Span {
  private ended = false
  constructor(
    readonly name: string,
    readonly kind: SpanKind,
    readonly context: SpanContext,
    private readonly attributes: Record<string, AttributeValue>,
    private readonly startTime: number,
    private readonly onEnd: (span: FinishedSpan) => void,
    private readonly clock: () => number,
    readonly parentSpanId?: string,
  ) {}

  setAttribute(key: string, value: AttributeValue): this {
    this.attributes[key] = value
    return this
  }

  private _status: SpanStatus = 'unset'
  private _statusMessage?: string
  setStatus(status: SpanStatus, message?: string): this {
    this._status = status
    if (message !== undefined) this._statusMessage = message
    return this
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    this.onEnd({
      name: this.name,
      kind: this.kind,
      context: this.context,
      startTime: this.startTime,
      endTime: this.clock(),
      attributes: this.attributes,
      status: this._status,
      ...(this.parentSpanId !== undefined ? { parentSpanId: this.parentSpanId } : {}),
      ...(this._statusMessage !== undefined ? { statusMessage: this._statusMessage } : {}),
    })
  }
}

export interface TracerOptions {
  exporter?: SpanExporter
  serviceName?: string
  sampled?: boolean
  clock?: () => number
  idGenerator?: { traceId(): string; spanId(): string }
}

const hex = (bytes: number): string => randomBytes(bytes).toString('hex')
const activeSpanStore = new AsyncLocalStorage<Span>()

/** The span currently in scope (set by `Tracer.inSpan`). */
export function activeSpan(): Span | undefined {
  return activeSpanStore.getStore()
}

export class Tracer {
  readonly serviceName: string
  private readonly exporter: SpanExporter | undefined
  private readonly clock: () => number
  private readonly traceFlags: number
  private readonly ids: { traceId(): string; spanId(): string }

  constructor(options: TracerOptions = {}) {
    this.exporter = options.exporter
    this.serviceName = options.serviceName ?? 'basalt'
    this.clock = options.clock ?? (() => Date.now())
    this.traceFlags = (options.sampled ?? true) ? 1 : 0
    this.ids = options.idGenerator ?? { traceId: () => hex(16), spanId: () => hex(8) }
  }

  startSpan(
    name: string,
    options: { parent?: SpanContext; kind?: SpanKind; attributes?: Record<string, AttributeValue> } = {},
  ): Span {
    const parent = options.parent ?? activeSpan()?.context
    const context: SpanContext = {
      traceId: parent?.traceId ?? this.ids.traceId(),
      spanId: this.ids.spanId(),
      traceFlags: parent?.traceFlags ?? this.traceFlags,
    }
    return new Span(
      name,
      options.kind ?? 'internal',
      context,
      { ...options.attributes },
      this.clock(),
      (span) => void this.exporter?.export([span]),
      this.clock,
      parent?.spanId,
    )
  }

  /** Runs `fn` with `span` as the active span, ending it afterwards. */
  async inSpan<T>(span: Span, fn: () => T | Promise<T>): Promise<T> {
    try {
      return await activeSpanStore.run(span, fn)
    } catch (error) {
      span.setStatus('error', error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      span.end()
    }
  }

  async forceFlush(): Promise<void> {
    await this.exporter?.forceFlush?.()
  }
}

// --- OTLP/HTTP JSON exporter ------------------------------------------------

const KIND_CODES: Record<SpanKind, number> = { internal: 1, server: 2, client: 3, producer: 4, consumer: 5 }
const STATUS_CODES: Record<SpanStatus, number> = { unset: 0, ok: 1, error: 2 }

const attrValue = (value: AttributeValue) =>
  typeof value === 'string'
    ? { stringValue: value }
    : typeof value === 'boolean'
      ? { boolValue: value }
      : Number.isInteger(value)
        ? { intValue: String(value) }
        : { doubleValue: value }

const attrs = (record: Record<string, AttributeValue>) =>
  Object.entries(record).map(([key, value]) => ({ key, value: attrValue(value) }))

/** Serializes spans to the OTLP/JSON `ExportTraceServiceRequest` shape. */
export function toOtlpJson(spans: FinishedSpan[], serviceName: string): unknown {
  return {
    resourceSpans: [
      {
        resource: { attributes: attrs({ 'service.name': serviceName }) },
        scopeSpans: [
          {
            scope: { name: '@basaltkit/core' },
            spans: spans.map((span) => ({
              traceId: span.context.traceId,
              spanId: span.context.spanId,
              ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
              name: span.name,
              kind: KIND_CODES[span.kind],
              startTimeUnixNano: String(span.startTime * 1_000_000),
              endTimeUnixNano: String(span.endTime * 1_000_000),
              attributes: attrs(span.attributes),
              status: {
                code: STATUS_CODES[span.status],
                ...(span.statusMessage ? { message: span.statusMessage } : {}),
              },
            })),
          },
        ],
      },
    ],
  }
}

export interface OtlpHttpExporterOptions {
  /** Collector base URL, e.g. http://localhost:4318 (path /v1/traces is appended). */
  url: string
  serviceName?: string
  headers?: Record<string, string>
  /** Flush when the buffer reaches this size. Default 100. */
  maxBatch?: number
  fetchImpl?: typeof fetch
}

/** Buffers spans and POSTs them to an OTLP/HTTP collector as OTLP/JSON. */
export class OtlpHttpExporter implements SpanExporter {
  private buffer: FinishedSpan[] = []
  private readonly endpoint: string
  private readonly serviceName: string
  private readonly headers: Record<string, string>
  private readonly maxBatch: number
  private readonly fetchImpl: typeof fetch

  constructor(options: OtlpHttpExporterOptions) {
    this.endpoint = `${options.url.replace(/\/$/, '')}/v1/traces`
    this.serviceName = options.serviceName ?? 'basalt'
    this.headers = options.headers ?? {}
    this.maxBatch = options.maxBatch ?? 100
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  export(spans: FinishedSpan[]): void {
    this.buffer.push(...spans)
    if (this.buffer.length >= this.maxBatch) void this.forceFlush()
  }

  async forceFlush(): Promise<void> {
    if (this.buffer.length === 0) return
    const batch = this.buffer
    this.buffer = []
    try {
      await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.headers },
        body: JSON.stringify(toOtlpJson(batch, this.serviceName)),
      })
    } catch {
      // best-effort: tracing must never break the request path
    }
  }
}
