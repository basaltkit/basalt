export type PlanStepKind =
  | 'generator'
  | 'schema'
  | 'migration'
  | 'service'
  | 'routes'
  | 'permissions'
  | 'audit'
  | 'test'
  | 'docs'
  | 'other'

export interface PlanField {
  name: string
  type: string
}

export interface PlanEntity {
  name: string
  fields: PlanField[]
  tenantScoped: boolean
  relations?: string[]
}

export interface PlanStep {
  order: number
  title: string
  kind: PlanStepKind
  detail: string
  /** Exact CLI command to run (mainly for `kind: 'generator'`). */
  command?: string
  /** Files the step creates or edits. */
  files?: string[]
}

export interface ArchitecturePlan {
  request: string
  summary: string
  entities: PlanEntity[]
  steps: PlanStep[]
  /** RBAC permissions to register, e.g. `patients.create`. */
  permissions: string[]
  /** Audit events to emit, e.g. `patient.created`. */
  auditEvents: string[]
  tenantScoped: boolean
  warnings: string[]
}
