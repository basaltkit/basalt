import type { ProjectContext } from '../context/project.js'

export type Severity = 'error' | 'warning' | 'info'

export type DiagnosticCategory =
  | 'security'
  | 'database'
  | 'observability'
  | 'tenancy'
  | 'performance'
  | 'durability'
  | 'config'

export interface Diagnostic {
  /** Stable slug — also the (future) `basalt ai:fix <id>` target. */
  id: string
  title: string
  severity: Severity
  category: DiagnosticCategory
  /** What the project currently does. */
  detected: string
  /** What it should do instead. */
  recommended: string
  /** Why it matters. */
  reason: string
  /** Suggested manual fix (code snippet or command). Auto-fix arrives in a later phase. */
  fix?: string
  /** Related docs path. */
  docs?: string
}

export interface DoctorRule {
  id: string
  category: DiagnosticCategory
  /** Returns a diagnostic when the rule fires, else `null`. */
  check(ctx: ProjectContext): Diagnostic | null
}

export function defineRule(rule: DoctorRule): DoctorRule {
  return rule
}
