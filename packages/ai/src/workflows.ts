/**
 * Framework-free provider-backed workflow surface: the AI provider factory and
 * the plan/review workflow steps — WITHOUT the `basalt ai` CLI wiring, which
 * imports `@basaltkit/cli` (→ `@basaltkit/core`). Sibling to `@basaltkit/ai/analysis`.
 *
 * It exists so out-of-process, dev-only consumers — notably `@basaltkit/ai-mcp` —
 * can build a provider and run plan/review without pulling `@basaltkit/core` or
 * `@basaltkit/http` into their dependency graph. Everything here is also exported
 * from the main barrel; this is a boundary-preserving subset, not a new API.
 */

// Provider factory + the vendor-agnostic surface.
export {
  createProvider,
  providerEnvFrom,
  providerEnvFromProcess,
  type CreateProviderOptions,
  type ProviderEnv,
  type ProviderName,
} from './provider/factory.js'
export {
  type AIMessage,
  type AIProvider,
  type FetchLike,
  type GenerateOptions,
} from './provider/types.js'

// Progress + cancellation vocabulary.
export { type OnProgress, type WorkflowProgress, type WorkflowRunOptions } from './generate.js'

// Planning.
export { createPlan, parsePlan, type CreatePlanOptions } from './plan/plan.js'
export type {
  ArchitecturePlan,
  PlanEntity,
  PlanField,
  PlanRelation,
  PlanStep,
  PlanStepKind,
} from './plan/types.js'

// Review — LLM critique of a build result.
export {
  buildReviewContext,
  parseReview,
  reviewImplementation,
  type ReviewOptions,
} from './review/review.js'
export type { AgentReview, ReviewIssue } from './review/types.js'

// Type of the input a review consumes (a make result). Type-only — no runtime pull.
export type { MakeResult } from './make/types.js'
