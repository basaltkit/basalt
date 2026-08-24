import type { Resource } from '@basaltkit/admin'
import { DEFAULT_BRANDING, type Branding } from './branding.js'

export type SectionKind = 'metrics' | 'resource' | 'audit' | 'queue' | 'custom'

export interface Section {
  key: string
  label: string
  kind: SectionKind
  /** Present for resource sections. */
  resource?: Resource
  /** Icon hint for the UI shell (e.g. a lucide icon name). */
  icon?: string
}

export interface DashboardConfig {
  title?: string
  /** White-label branding; the title defaults to `branding.productName`. */
  branding?: Branding
  sections: Section[]
}

/** The navigable model an admin shell (React, etc.) renders. */
export class Dashboard {
  readonly title: string
  readonly branding: Branding
  readonly sections: Section[]

  constructor(config: DashboardConfig) {
    this.branding = config.branding ?? DEFAULT_BRANDING
    this.title = config.title ?? this.branding.productName
    this.sections = config.sections
  }

  section(key: string): Section | undefined {
    return this.sections.find((section) => section.key === key)
  }

  /** Navigation model for the sidebar. */
  nav(): { key: string; label: string; icon?: string }[] {
    return this.sections.map((section) => ({
      key: section.key,
      label: section.label,
      ...(section.icon ? { icon: section.icon } : {}),
    }))
  }
}

export function defineDashboard(config: DashboardConfig): Dashboard {
  return new Dashboard(config)
}

// --- section builders ----------------------------------------------------

export function resourceSection(resource: Resource, options: { icon?: string; key?: string } = {}): Section {
  return {
    key: options.key ?? resource.name,
    label: resource.label,
    kind: 'resource',
    resource,
    ...(options.icon ? { icon: options.icon } : {}),
  }
}

export function metricsSection(options: { key?: string; label?: string; icon?: string } = {}): Section {
  return {
    key: options.key ?? 'overview',
    label: options.label ?? 'Overview',
    kind: 'metrics',
    ...(options.icon ? { icon: options.icon } : {}),
  }
}

export function auditSection(options: { key?: string; label?: string; icon?: string } = {}): Section {
  return {
    key: options.key ?? 'audit',
    label: options.label ?? 'Audit Log',
    kind: 'audit',
    ...(options.icon ? { icon: options.icon } : {}),
  }
}

export function queueSection(options: { key?: string; label?: string; icon?: string } = {}): Section {
  return {
    key: options.key ?? 'queues',
    label: options.label ?? 'Queues',
    kind: 'queue',
    ...(options.icon ? { icon: options.icon } : {}),
  }
}

export interface StandardDashboardOptions {
  title?: string
  /** Admin resources to expose as sidebar sections. */
  resources?: Resource[]
  /** Include the billing/metrics Overview. Default: true. */
  billing?: boolean
  /** Include the Queues section. Default: false. */
  queues?: boolean
  /** Include the Audit Log section. Default: false. */
  audit?: boolean
}

/**
 * Assembles a conventional admin dashboard — Overview, your resources, then
 * Queues and Audit — with sensible labels and icon hints. A shortcut over
 * hand-listing sections; the shell still renders it via `nav()`/`section()`.
 */
export function standardDashboard(options: StandardDashboardOptions = {}): Dashboard {
  const sections: Section[] = []
  if (options.billing !== false) sections.push(metricsSection({ icon: 'bar-chart' }))
  for (const resource of options.resources ?? []) sections.push(resourceSection(resource, { icon: 'box' }))
  if (options.queues) sections.push(queueSection({ icon: 'layers' }))
  if (options.audit) sections.push(auditSection({ icon: 'scroll' }))
  return defineDashboard({ ...(options.title ? { title: options.title } : {}), sections })
}
