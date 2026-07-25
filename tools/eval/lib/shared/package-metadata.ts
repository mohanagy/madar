import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type PackageJson = {
  name?: unknown
  version?: unknown
}

export function findPackageRoot(startDirectory = dirname(fileURLToPath(import.meta.url))): string {
  let currentDirectory = resolve(startDirectory)

  while (true) {
    const packageJsonPath = join(currentDirectory, 'package.json')
    if (existsSync(packageJsonPath)) {
      return currentDirectory
    }

    const parentDirectory = dirname(currentDirectory)
    if (parentDirectory === currentDirectory) {
      throw new Error('Could not locate package root from package metadata helper')
    }
    currentDirectory = parentDirectory
  }
}

function readPackageJson(packageRoot: string): PackageJson | null {
  try {
    return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as PackageJson
  } catch {
    return null
  }
}

export function readPackageName(packageRoot = findPackageRoot()): string {
  const packageJson = readPackageJson(packageRoot)
  if (typeof packageJson?.name === 'string' && packageJson.name.trim().length > 0) {
    return packageJson.name
  }

  return 'unknown'
}

export function readPackageVersion(packageRoot = findPackageRoot()): string {
  const packageJson = readPackageJson(packageRoot)
  if (typeof packageJson?.version === 'string' && packageJson.version.trim().length > 0) {
    return packageJson.version
  }

  return 'unknown'
}
