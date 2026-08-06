/**
 * Zero-dependency metrics primitives that render to the Prometheus text
 * exposition format. Counters, gauges and histograms with labels — enough to
 * drive a `/metrics` endpoint or push to any Prometheus-compatible scraper,
 * without pulling a client library.
 */

export type Labels = Record<string, string>

const SEP = '\x1f'
const labelKey = (labels: Labels, names: string[]): string => names.map((name) => labels[name] ?? '').join(SEP)

const escapeLabelValue = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')

function renderLabels(labels: Labels, names: string[], extra?: Labels): string {
  const parts: string[] = []
  for (const name of names) {
    const value = labels[name]
    if (value !== undefined) parts.push(`${name}="${escapeLabelValue(value)}"`)
  }
  if (extra) for (const [k, v] of Object.entries(extra)) parts.push(`${k}="${escapeLabelValue(v)}"`)
  return parts.length ? `{${parts.join(',')}}` : ''
}

export abstract class Metric {
  abstract readonly type: 'counter' | 'gauge' | 'histogram'
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: string[] = [],
  ) {}
  abstract render(): string
  protected header(): string {
    return `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} ${this.type}\n`
  }
}

export class Counter extends Metric {
  readonly type = 'counter' as const
  private readonly series = new Map<string, { labels: Labels; value: number }>()

  inc(labels: Labels = {}, value = 1): void {
    if (value < 0) throw new Error('Counter can only increase')
    const key = labelKey(labels, this.labelNames)
    const entry = this.series.get(key) ?? { labels, value: 0 }
    entry.value += value
    this.series.set(key, entry)
  }

  render(): string {
    let out = this.header()
    if (this.series.size === 0) out += `${this.name} 0\n`
    for (const { labels, value } of this.series.values()) {
      out += `${this.name}${renderLabels(labels, this.labelNames)} ${value}\n`
    }
    return out
  }
}

export class Gauge extends Metric {
  readonly type = 'gauge' as const
  private readonly series = new Map<string, { labels: Labels; value: number }>()

  private mutate(labels: Labels, fn: (current: number) => number): void {
    const key = labelKey(labels, this.labelNames)
    const entry = this.series.get(key) ?? { labels, value: 0 }
    entry.value = fn(entry.value)
    this.series.set(key, entry)
  }
  set(value: number, labels: Labels = {}): void {
    this.mutate(labels, () => value)
  }
  inc(labels: Labels = {}, value = 1): void {
    this.mutate(labels, (current) => current + value)
  }
  dec(labels: Labels = {}, value = 1): void {
    this.mutate(labels, (current) => current - value)
  }

  render(): string {
    let out = this.header()
    if (this.series.size === 0) out += `${this.name} 0\n`
    for (const { labels, value } of this.series.values()) {
      out += `${this.name}${renderLabels(labels, this.labelNames)} ${value}\n`
    }
    return out
  }
}

export const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

export class Histogram extends Metric {
  readonly type = 'histogram' as const
  private readonly series = new Map<string, { labels: Labels; buckets: number[]; sum: number; count: number }>()
  readonly buckets: number[]

  constructor(name: string, help: string, labelNames: string[] = [], buckets: number[] = DEFAULT_BUCKETS) {
    super(name, help, labelNames)
    this.buckets = [...buckets].sort((a, b) => a - b)
  }

  observe(value: number, labels: Labels = {}): void {
    const key = labelKey(labels, this.labelNames)
    let entry = this.series.get(key)
    if (!entry) {
      entry = { labels, buckets: new Array(this.buckets.length).fill(0), sum: 0, count: 0 }
      this.series.set(key, entry)
    }
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]!) entry.buckets[i]! += 1
    }
    entry.sum += value
    entry.count += 1
  }

  render(): string {
    let out = this.header()
    for (const { labels, buckets, sum, count } of this.series.values()) {
      // `buckets[i]` is already cumulative: observe() increments every threshold
      // whose value is >= the observation, so each entry counts observations <= le.
      for (let i = 0; i < this.buckets.length; i++) {
        out += `${this.name}_bucket${renderLabels(labels, this.labelNames, { le: String(this.buckets[i]) })} ${buckets[i]}\n`
      }
      out += `${this.name}_bucket${renderLabels(labels, this.labelNames, { le: '+Inf' })} ${count}\n`
      out += `${this.name}_sum${renderLabels(labels, this.labelNames)} ${sum}\n`
      out += `${this.name}_count${renderLabels(labels, this.labelNames)} ${count}\n`
    }
    return out
  }
}

export interface MetricOptions {
  help?: string
  labelNames?: string[]
}

/** A collection of metrics that renders them all in Prometheus text format. */
export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>()

  private getOrCreate<T extends Metric>(name: string, create: () => T): T {
    const existing = this.metrics.get(name)
    if (existing) return existing as T
    const metric = create()
    this.metrics.set(name, metric)
    return metric
  }

  counter(name: string, options: MetricOptions = {}): Counter {
    return this.getOrCreate(name, () => new Counter(name, options.help ?? name, options.labelNames))
  }
  gauge(name: string, options: MetricOptions = {}): Gauge {
    return this.getOrCreate(name, () => new Gauge(name, options.help ?? name, options.labelNames))
  }
  histogram(name: string, options: MetricOptions & { buckets?: number[] } = {}): Histogram {
    return this.getOrCreate(name, () => new Histogram(name, options.help ?? name, options.labelNames, options.buckets))
  }

  /** Prometheus text exposition (content-type text/plain; version=0.0.4). */
  render(): string {
    return [...this.metrics.values()].map((metric) => metric.render()).join('\n')
  }
}
