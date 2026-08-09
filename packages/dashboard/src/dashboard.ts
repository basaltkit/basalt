import type { Resource } from '@basaltkit/admin'

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
  sections: Section[]
}

/** The navigable model an admin shell (React, etc.) renders. */
export class Dashboard {
  readonly title: string
  readonly sections: Section[]

  constructor(config: DashboardConfig) {
    this.title = config.title ?? 'Admin'
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
