/**
 * Framework-free resource-generation surface: the code generator and its file
 * writers, WITHOUT `generatorCommands` — which imports `@basaltkit/cli`
 * (→ `@basaltkit/core`). The main barrel re-exports the commands, so importing
 * from it transitively loads the framework runtime; this subpath does not.
 *
 * It exists so out-of-process, dev-only consumers — the `@basaltkit/ai` workflow
 * engine and, through it, `@basaltkit/ai-mcp` — can scaffold resources without
 * pulling `@basaltkit/core`/`http`/`cli` into their dependency graph. Everything
 * here is also exported from the main barrel; this is a boundary-preserving subset.
 */
export { names, type Names } from './names.js'
export type { GeneratedFile } from './templates.js'
export {
  GENERATORS,
  generate,
  generateResource,
  writeGenerated,
  registerResourceInApp,
  FileExistsError,
  type GeneratorKind,
  type GeneratorOptions,
  type WriteOptions,
  type AppRegistration,
} from './generate.js'
