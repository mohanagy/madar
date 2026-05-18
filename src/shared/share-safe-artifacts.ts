import { basename, relative, resolve, sep } from 'node:path'

export interface ShareSafePathRoots {
  artifactRoot: string
  projectRoot: string
}

function sameResolvedPath(path: string, root: string): boolean {
  return resolve(path) === resolve(root)
}

function isWithinRoot(path: string, root: string): boolean {
  const resolvedRoot = resolve(root)
  const resolvedPath = resolve(path)
  const rootPrefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`
  return resolvedPath.startsWith(rootPrefix)
}

function toPortableShareSafeSuffix(path: string): string {
  return path.split(sep).join('/')
}

export function toShareSafeArtifactPath(path: string, roots: ShareSafePathRoots): string {
  if (sameResolvedPath(path, roots.artifactRoot)) return '<artifact-root>'
  if (isWithinRoot(path, roots.artifactRoot)) {
    return `<artifact-root>/${toPortableShareSafeSuffix(relative(roots.artifactRoot, path))}`
  }
  if (sameResolvedPath(path, roots.projectRoot)) return '<project-root>'
  if (isWithinRoot(path, roots.projectRoot)) {
    return `<project-root>/${toPortableShareSafeSuffix(relative(roots.projectRoot, path))}`
  }
  return basename(path)
}
