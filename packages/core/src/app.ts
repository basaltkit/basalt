import { Container } from './container.js'
import { ConfigValidationError, LifecycleError, PluginDependencyError } from './errors.js'
import { HookBus } from './hooks.js'
import type { MachizePlugin, PluginContext } from './plugin.js'

export type LifecyclePhase =
  | 'created'
  | 'registering'
  | 'booting'
  | 'ready'
  | 'shutting-down'
  | 'stopped'

export interface CreateAppOptions {
  plugins?: MachizePlugin<never>[] | MachizePlugin<any>[]
  /** Raw config, keyed by plugin name (e.g. `{ 'machize:cache': { driver: 'memory' } }`) */
  config?: Record<string, unknown>
}

declare module './hooks.js' {
  interface MachizeHooks {
    'app:registered': { app: MachizeApp }
    'app:booted': { app: MachizeApp }
    'app:shutdown': { app: MachizeApp }
  }
}

export class MachizeApp {
  readonly container = new Container()
  readonly hooks = new HookBus()
  phase: LifecyclePhase = 'created'

  private readonly plugins: MachizePlugin<any>[]
  private readonly rawConfig: Record<string, unknown>
  private booted: { plugin: MachizePlugin<any>; context: PluginContext<any> }[] = []

  constructor(options: CreateAppOptions = {}) {
    this.plugins = sortPlugins(options.plugins ?? [])
    this.rawConfig = options.config ?? {}
  }

  async boot(): Promise<this> {
    if (this.phase !== 'created') {
      throw new LifecycleError(`boot() called in phase "${this.phase}" — it is only allowed once.`)
    }

    const contexts: { plugin: MachizePlugin<any>; context: PluginContext<any> }[] = []

    this.phase = 'registering'
    for (const plugin of this.plugins) {
      const config = this.resolveConfig(plugin)
      const context: PluginContext<any> = {
        container: this.container,
        hooks: this.hooks,
        config,
      }
      contexts.push({ plugin, context })
      await plugin.register?.(context)
    }
    await this.hooks.emit('app:registered', { app: this })

    this.phase = 'booting'
    for (const entry of contexts) {
      await entry.plugin.boot?.(entry.context)
      this.booted.push(entry)
    }

    this.phase = 'ready'
    await this.hooks.emit('app:booted', { app: this })
    return this
  }

  async shutdown(): Promise<void> {
    if (this.phase === 'stopped' || this.phase === 'shutting-down') return
    this.phase = 'shutting-down'
    // reverse boot order; a failing shutdown does not prevent the others
    const errors: unknown[] = []
    for (const { plugin, context } of [...this.booted].reverse()) {
      try {
        await plugin.shutdown?.(context)
      } catch (error) {
        errors.push(error)
      }
    }
    await this.hooks.emit('app:shutdown', { app: this })
    this.phase = 'stopped'
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failures during plugin shutdown')
    }
  }

  private resolveConfig(plugin: MachizePlugin<any>): unknown {
    const raw = this.rawConfig[plugin.name]
    if (!plugin.configSchema) return raw
    const result = plugin.configSchema.safeParse(raw)
    if (!result.success) throw new ConfigValidationError(plugin.name, result.error)
    return result.data
  }
}

export function createApp(options: CreateAppOptions = {}): MachizeApp {
  return new MachizeApp(options)
}

/** Topological sort by dependsOn, with cycle and missing-dependency detection. */
function sortPlugins(plugins: MachizePlugin<any>[]): MachizePlugin<any>[] {
  const byName = new Map<string, MachizePlugin<any>>()
  for (const plugin of plugins) {
    if (byName.has(plugin.name)) {
      throw new PluginDependencyError(`Duplicate plugin: "${plugin.name}"`)
    }
    byName.set(plugin.name, plugin)
  }

  const sorted: MachizePlugin<any>[] = []
  const visiting = new Set<string>()
  const visited = new Set<string>()

  const visit = (plugin: MachizePlugin<any>, path: string[]) => {
    if (visited.has(plugin.name)) return
    if (visiting.has(plugin.name)) {
      throw new PluginDependencyError(
        `Dependency cycle between plugins: ${[...path, plugin.name].join(' -> ')}`,
      )
    }
    visiting.add(plugin.name)
    for (const dep of plugin.dependsOn ?? []) {
      const dependency = byName.get(dep)
      if (!dependency) {
        throw new PluginDependencyError(
          `Plugin "${plugin.name}" depends on "${dep}", which was not added to the app.`,
        )
      }
      visit(dependency, [...path, plugin.name])
    }
    visiting.delete(plugin.name)
    visited.add(plugin.name)
    sorted.push(plugin)
  }

  for (const plugin of plugins) visit(plugin, [])
  return sorted
}
