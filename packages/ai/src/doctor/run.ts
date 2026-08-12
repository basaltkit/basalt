import type { ProjectContext } from '../context/project.js'
import { DEFAULT_RULES } from './rules.js'
import type { Diagnostic, DoctorRule, Severity } from './types.js'

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 }

/**
 * Run every rule against the project context and return the diagnostics that
 * fired, most severe first.
 */
export function runDoctor(ctx: ProjectContext, rules: DoctorRule[] = DEFAULT_RULES): Diagnostic[] {
  return rules
    .map((rule) => rule.check(ctx))
    .filter((d): d is Diagnostic => d !== null)
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
}

/** True when any diagnostic is an error — lets CI gate on `ai:doctor`. */
export function hasErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error')
}
