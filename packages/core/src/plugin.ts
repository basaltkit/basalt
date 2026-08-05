import type { Container } from './container.js'
import type { HookBus } from './hooks.js'

/**
 * Schema estrutural compatível com Zod (safeParse), sem dependência de runtime.
 * Qualquer validador com a mesma forma funciona.
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
  /** Nome único, por convenção `machize:<pacote>` ou `app:<nome>` */
  name: string
  /** Nomes de plugins que precisam registrar/bootar antes deste */
  dependsOn?: string[]
  /** Valida a fatia de config do plugin no boot — fail fast */
  configSchema?: ConfigSchema<TConfig>
  /** Fase 1: registrar bindings no container. Sem side effects de I/O. */
  register?(context: PluginContext<TConfig>): void | Promise<void>
  /** Fase 2: conectar, assinar hooks, iniciar recursos. */
  boot?(context: PluginContext<TConfig>): void | Promise<void>
  /** Desligamento gracioso, em ordem reversa de boot. */
  shutdown?(context: PluginContext<TConfig>): void | Promise<void>
}

export function definePlugin<TConfig = unknown>(
  plugin: MachizePlugin<TConfig>,
): MachizePlugin<TConfig> {
  return plugin
}
