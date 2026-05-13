import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function findPackageRoot(startDirectory = dirname(fileURLToPath(import.meta.url))): string {
  let currentDirectory = resolve(startDirectory)

  while (true) {
    const packageJsonPath = join(currentDirectory, 'package.json')
    if (existsSync(packageJsonPath)) {
      return currentDirectory
    }

    const parentDirectory = dirname(currentDirectory)
    if (parentDirectory === currentDirectory) {
      throw new Error('Could not locate package root from graphify-ts package metadata helper')
    }
    currentDirectory = parentDirectory
  }
}

export function readPackageVersion(packageRoot = findPackageRoot()): string {
  try {
    const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version?: unknown }
    if (typeof packageJson.version === 'string' && packageJson.version.trim().length > 0) {
      return packageJson.version
    }
  } catch {
    // ignore and fall back below
  }

  return 'unknown'
}
