import type { Container } from './container.js'
import type { HookBus } from './hooks.js'

/**
 * Structural schema compatible with Zod (safeParse), without a runtime dependency.
 * Any validator with the same shape works.
 */
export interface ConfigSchema<T> {
  safeParse(input: unknown): { success: boolean; data?: T; error?: unknown }
}

export interface PluginContext<TConfig = unknown> {
  container: Container
  hooks: HookBus
  config: TConfig
}

export interface MachizePlugin<TConfig = unknown> {
  /** Unique name, by convention `machize:<package>` or `app:<name>` */
  name: string
  /** Names of plugins that must register/boot before this one */
  dependsOn?: string[]
  /** Validates the plugin's config slice at boot — fail fast */
  configSchema?: ConfigSchema<TConfig>
  /** Phase 1: register bindings in the container. No I/O side effects. */
  register?(context: PluginContext<TConfig>): void | Promise<void>
  /** Phase 2: connect, subscribe to hooks, start resources. */
  boot?(context: PluginContext<TConfig>): void | Promise<void>
  /** Graceful shutdown, in reverse boot order. */
  shutdown?(context: PluginContext<TConfig>): void | Promise<void>
}

export function definePlugin<TConfig = unknown>(
  plugin: MachizePlugin<TConfig>,
): MachizePlugin<TConfig> {
  return plugin
}
