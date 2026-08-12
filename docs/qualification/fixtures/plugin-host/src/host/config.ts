export interface HostConfig {
  enabledPlugins: string[]
  pluginSettings: Record<string, Record<string, string>>
  failFast: boolean
}

const DEFAULT_CONFIG: HostConfig = {
  enabledPlugins: ['csv-export'],
  pluginSettings: {},
  failFast: false,
}

/**
 * Layered resolution: defaults, then file config, then environment overrides.
 * Only `host/plugin-host.ts` is expected to call this.
 */
export function resolveHostConfig(
  fileConfig: Partial<HostConfig>,
  env: Record<string, string | undefined>,
): HostConfig {
  const enabledFromEnv = env.EXPORT_PLUGINS?.split(',').map((name) => name.trim()).filter(Boolean)

  return {
    enabledPlugins: enabledFromEnv ?? fileConfig.enabledPlugins ?? DEFAULT_CONFIG.enabledPlugins,
    pluginSettings: { ...DEFAULT_CONFIG.pluginSettings, ...fileConfig.pluginSettings },
    failFast: env.EXPORT_FAIL_FAST === '1' ? true : (fileConfig.failFast ?? DEFAULT_CONFIG.failFast),
  }
}

export function settingsFor(config: HostConfig, pluginName: string): Record<string, string> {
  return config.pluginSettings[pluginName] ?? {}
}
