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
  /**
   * Allowed values — makes this a `z.enum([...])` field (validated on input,
   * stored as a String column). E.g. a status: `['pago', 'pendente']`.
   */
  enum?: string[]
}

/** A belongs-to relation: this entity holds a `<name>Id` FK referencing `model`. */
export interface PlanRelation {
  /** Relation field name on this model, e.g. `paciente`. */
  name: string
  /** Related model, e.g. `Paciente`. */
  model: string
}

export interface PlanEntity {
  name: string
  fields: PlanField[]
  tenantScoped: boolean
  relations?: PlanRelation[]
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
  /**
   * Serialization contract version. Producers (`createPlan`/`parsePlan`) always
   * set it; it is optional on the type so hand-constructed plans and older,
   * unversioned plans round-tripped from a client still satisfy the interface.
   */
  schemaVersion?: number
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
