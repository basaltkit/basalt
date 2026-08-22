export { defineCommand, type CommandDefinition, type CommandContext, type CommandIo } from './command.js'
export { runCli, type RunCliOptions } from './runner.js'
export { commandsPlugin } from './plugin.js'
export { consoleIo, memoryIo, renderTable } from './io.js'
export { parseArgv, type ParsedArgv } from './parse.js'
export {
  builtinCommands,
  routesCommand,
  scheduleListCommand,
  type RouteMetadata,
  type ScheduleMetadata,
} from './builtins.js'
export {
  devCommand,
  resolveDevEntry,
  resolveDevRunner,
  devRouteRows,
  DEV_ENTRY_CANDIDATES,
  type DevRunner,
  type DevRoute,
} from './dev.js'
export {
  upgradeCommand,
  runUpgrade,
  MIGRATIONS,
  renameMachizeScope,
  nodeUpgradeFs,
  type Migration,
  type Edit,
  type UpgradeFs,
  type UpgradeReport,
} from './upgrade.js'
export {
  publishCommand,
  runPublish,
  PUBLISHABLES,
  nodePublishFs,
  type Publishable,
  type PublishableFile,
  type PublishFs,
  type PublishResult,
} from './publish.js'
