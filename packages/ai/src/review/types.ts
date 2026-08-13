export interface ReviewIssue {
  /** e.g. `tenancy`, `security`, `rbac`, `validation`, `tests`, `fit`. */
  dimension: string
  severity: 'error' | 'warning'
  message: string
}

export interface AgentReview {
  /** Derived: true only when no issue is error-severity. */
  approved: boolean
  summary: string
  issues: ReviewIssue[]
}
