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
export { generatorCommands } from './commands.js'
