export interface ResolvedShellCommand {
  file: string
  args: string[]
  useProcessGroup: boolean
}

export function shellEscape(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return `"${value.replaceAll('%', '%%').replaceAll('"', '""')}"`
  }
  return `'${value.replaceAll("'", `'\"'\"'`)}'`
}

export function shellEscapeIfNeeded(value: string, platform: NodeJS.Platform = process.platform): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value
  }
  return shellEscape(value, platform)
}

export function resolveShellCommand(command: string, platform: NodeJS.Platform = process.platform): ResolvedShellCommand {
  if (platform === 'win32') {
    return {
      file: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', command],
      useProcessGroup: false,
    }
  }
  return {
    file: '/bin/sh',
    args: ['-lc', command],
    useProcessGroup: true,
  }
}
