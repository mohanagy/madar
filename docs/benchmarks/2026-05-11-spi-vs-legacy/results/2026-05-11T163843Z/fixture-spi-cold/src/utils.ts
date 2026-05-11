// Plain utility code without framework metadata.

export function formatDate(): string {
  return new Date().toISOString()
}

export function parseQueryString(): Record<string, string> {
  return {}
}

export function debounce(): (...args: unknown[]) => void {
  return () => undefined
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
