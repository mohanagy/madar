import { cpSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

export interface CopyWorkspaceOptions {
  sharedTopLevelEntries?: readonly string[]
}

function filterWorkspaceCopy(sourceRoot: string, sourcePath: string, sharedTopLevelEntries: ReadonlySet<string>): boolean {
  const relativePath = relative(sourceRoot, sourcePath)
  if (sharedTopLevelEntries.size > 0) {
    const [topLevel = ''] = relativePath.split(sep, 1)
    if (sharedTopLevelEntries.has(topLevel)) {
      return false
    }
  }
  return (
    relativePath !== 'out'
    && !relativePath.startsWith(`out${sep}`)
    && relativePath !== '.git'
    && !relativePath.startsWith(`.git${sep}`)
  )
}

function symlinkKindForEntry(entryPath: string): 'file' | 'dir' | 'junction' {
  if (lstatSync(entryPath).isDirectory()) {
    return process.platform === 'win32' ? 'junction' : 'dir'
  }
  return 'file'
}

function linkSharedTopLevelEntries(
  sourceRoot: string,
  targetRoot: string,
  sharedTopLevelEntries: readonly string[],
): void {
  for (const entry of sharedTopLevelEntries) {
    const sourceEntryPath = join(sourceRoot, entry)
    if (!existsSync(sourceEntryPath)) {
      continue
    }
    const targetEntryPath = join(targetRoot, entry)
    mkdirSync(dirname(targetEntryPath), { recursive: true })
    rmSync(targetEntryPath, { recursive: true, force: true })
    symlinkSync(sourceEntryPath, targetEntryPath, symlinkKindForEntry(sourceEntryPath))
  }
}

export function copyWorkspaceForBenchmark(sourceRoot: string, targetRoot: string, options: CopyWorkspaceOptions = {}): void {
  const sharedTopLevelEntries = options.sharedTopLevelEntries ?? []
  const sharedTopLevelEntrySet = new Set(sharedTopLevelEntries)
  mkdirSync(dirname(targetRoot), { recursive: true })
  cpSync(sourceRoot, targetRoot, {
    recursive: true,
    filter: (sourcePath) => filterWorkspaceCopy(sourceRoot, sourcePath, sharedTopLevelEntrySet),
  })
  linkSharedTopLevelEntries(sourceRoot, targetRoot, sharedTopLevelEntries)
}
