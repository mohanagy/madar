import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Publish one text artifact with same-filesystem rename semantics. */
export function writeTextFileAtomically(outputPath: string, content: string): void {
  mkdirSync(dirname(outputPath), { recursive: true })
  const temporaryPath = join(
    dirname(outputPath),
    `.madar-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  )
  try {
    writeFileSync(temporaryPath, content, 'utf8')
    renameSync(temporaryPath, outputPath)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}

/** Stronger cache identity than mtime/size alone for atomically replaced files. */
export function fileIdentity(path: string): string {
  const stats = statSync(path)
  return `${stats.dev}:${stats.ino}:${stats.ctimeMs}:${stats.mtimeMs}:${stats.size}`
}
