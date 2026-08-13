// Provider layer — the vendor-agnostic AI surface (spec §17).
export {
  singleChunkStream,
  type AIMessage,
  type AIProvider,
  type FetchLike,
  type GenerateOptions,
} from './provider/types.js'
export { AnthropicProvider, type AnthropicProviderOptions } from './provider/anthropic.js'
export { OllamaProvider, type OllamaProviderOptions } from './provider/ollama.js'
export {
  OpenAICompatibleProvider,
  type OpenAICompatibleProviderOptions,
} from './provider/openai.js'
export { fetchWithRetry, type RetryOptions } from './provider/http.js'
export { globalSseFetch, parseSseContent, type SseFetch, type SseResponse } from './provider/sse.js'
export {
  createProvider,
  providerEnvFromProcess,
  type CreateProviderOptions,
  type ProviderEnv,
  type ProviderName,
} from './provider/factory.js'

// Project context — stack/schema/config detection (spec §18, Context Engineering).
export {
  detectProject,
  nodeReader,
  memoryReader,
  type AppFileInfo,
  type DetectedStack,
  type EnvFileInfo,
  type PrismaInfo,
  type PrismaModel,
  type ProjectContext,
  type ProjectReader,
  type ServerFileInfo,
} from './context/project.js'

// Diagnostics engine (spec §6, Doctor).
export {
  defineRule,
  type Diagnostic,
  type DiagnosticCategory,
  type DoctorRule,
  type Severity,
} from './doctor/types.js'
export { DEFAULT_RULES } from './doctor/rules.js'
export { hasErrors, runDoctor } from './doctor/run.js'

// Analysis report (spec §5, Analyze).
export { analyze, type AnalysisReport } from './analyze/run.js'

// Planning (spec §3, Plan mode) — natural language → architecture plan.
export { createPlan, parsePlan, type CreatePlanOptions } from './plan/plan.js'
export { buildPlanContext } from './plan/context.js'
export { BASALT_KNOWLEDGE } from './plan/knowledge.js'
export { renderPlan } from './plan/render.js'
export type {
  ArchitecturePlan,
  PlanEntity,
  PlanField,
  PlanStep,
  PlanStepKind,
} from './plan/types.js'

// Implementation (spec §4 Implement) — execute a plan via the generator + review gate.
export { runMake } from './make/make.js'
export { renderMakeResult } from './make/render.js'
export { verifyProject, type VerifyResult } from './make/verify.js'
export {
  canonicalType,
  domainFields,
  injectPrismaFields,
  injectZodFields,
  prismaType,
  zodValidator,
  type CanonicalType,
} from './make/fields.js'
export { renderPrismaRepository, type RepositoryOptions } from './make/repository.js'
export { injectAuditPlugin, injectAuditService, injectPermissionGuards } from './make/wire.js'
export type {
  MakeOptions,
  MakeResult,
  ResourceBuild,
  ReviewItem,
  ReviewResult,
  ReviewStatus,
} from './make/types.js'

// Rendering + CLI wiring.
export { renderAnalysis, renderDoctor, type LineWriter } from './render.js'
export { aiCommands, type AiCommandsOptions } from './commands.js'
