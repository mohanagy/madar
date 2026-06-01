export function shellEscape(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return `'${value.replaceAll("'", "''")}'`
  }
  return `'${value.replaceAll("'", `'\"'\"'`)}'`
}

export function shellEscapeIfNeeded(value: string, platform: NodeJS.Platform = process.platform): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value
  }
  return shellEscape(value, platform)
}
