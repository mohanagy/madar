import type { ExportPlugin } from '../contracts/plugin.js'

export class DuplicatePluginError extends Error {
  constructor(name: string) {
    super(`plugin ${name} is already registered`)
    this.name = 'DuplicatePluginError'
  }
}

export class UnknownPluginError extends Error {
  constructor(name: string) {
    super(`plugin ${name} is not registered`)
    this.name = 'UnknownPluginError'
  }
}

/**
 * Name -> plugin resolution. Registration order is preserved so lifecycle
 * ordering is deterministic.
 */
export class PluginRegistry {
  private readonly plugins = new Map<string, ExportPlugin>()

  register(plugin: ExportPlugin): void {
    if (this.plugins.has(plugin.name)) {
      throw new DuplicatePluginError(plugin.name)
    }
    this.plugins.set(plugin.name, plugin)
  }

  resolve(name: string): ExportPlugin {
    const plugin = this.plugins.get(name)
    if (!plugin) {
      throw new UnknownPluginError(name)
    }
    return plugin
  }

  resolveAll(names: string[]): ExportPlugin[] {
    return names.map((name) => this.resolve(name))
  }

  registeredNames(): string[] {
    return [...this.plugins.keys()]
  }
}
