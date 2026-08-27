/**
 * Framework-free read-only surface: project detection, analysis, diagnostics
 * (with in-memory fix previews) and the BasaltKit architectural knowledge —
 * WITHOUT the `basalt ai` CLI command wiring, which imports `@basaltkit/cli`
 * (→ `@basaltkit/core`). The main barrel (`@basaltkit/ai`) re-exports `aiCommands`
 * and therefore transitively loads the framework runtime; this subpath does not.
 *
 * It exists so out-of-process, dev-only consumers — notably the `@basaltkit/ai-mcp`
 * bridge — can use analyze/doctor/context without pulling `@basaltkit/core` or
 * `@basaltkit/http` into their dependency graph. Everything here is also exported
 * from the main barrel; this is a boundary-preserving subset, not a new API.
 */

// Project context — stack/schema/config detection.
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

// Analysis report.
export { analyze, type AnalysisReport } from './analyze/run.js'

// Diagnostics engine.
export { hasErrors, runDoctor } from './doctor/run.js'
export { DEFAULT_RULES } from './doctor/rules.js'
export {
  defineRule,
  type Diagnostic,
  type DiagnosticCategory,
  type DoctorRule,
  type Severity,
} from './doctor/types.js'

// Fix previews — computed in memory; `planFix` never writes to disk.
export {
  fixableIds,
  planFix,
  type FileEdit,
  type FixOutcome,
  type FixStatus,
} from './doctor/fixes.js'

// The framework conventions the planner is grounded in.
export { BASALT_KNOWLEDGE } from './plan/knowledge.js'
