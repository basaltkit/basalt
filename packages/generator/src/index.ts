export { names, type Names } from './names.js'
export { moduleFile, type ModuleArtifact, type GeneratedFile, type TenantMode } from './templates.js'
export {
  GENERATORS,
  generate,
  generateResource,
  writeGenerated,
  appendPrismaModel,
  PRISMA_SCHEMA,
  addSqliteMigration,
  SQLITE_DATABASE,
  registerResourceInApp,
  serviceSiblingsExist,
  expectedSiblings,
  missingSiblings,
  missingSiblingsWarning,
  FileExistsError,
  type GeneratorKind,
  type GeneratorOptions,
  type PrismaClientRef,
  type WriteOptions,
  type AppRegistration,
  type SqliteMigrationResult,
} from './generate.js'
export { generatorCommands } from './commands.js'
