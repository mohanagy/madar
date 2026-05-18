import { realpathSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

export interface ShareSafePathRoots {
  artifactRoot: string
  projectRoot: string
}

const ABSOLUTE_PATH_TOKEN_PATTERN = /(?:[A-Za-z]:[\\/]|\/)[^\s"'`<>]+/g
const TRAILING_PATH_PUNCTUATION = new Set([',', '.', ':', ';', ')', ']', '}'])

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

function addPathAlias(path: string, aliases: Set<string>): void {
  aliases.add(resolve(path))
  if (path.startsWith('/private/')) {
    aliases.add(path.slice('/private'.length))
  } else if (path.startsWith('/var/')) {
    aliases.add(`/private${path}`)
  }

  try {
    const realPath = realpathSync(path)
    aliases.add(realPath)
    if (realPath.startsWith('/private/')) {
      aliases.add(realPath.slice('/private'.length))
    } else if (realPath.startsWith('/var/')) {
      aliases.add(`/private${realPath}`)
    }
  } catch {
    // Ignore paths that do not exist when building aliases.
  }
}

function rootAliases(root: string): string[] {
  const aliases = new Set<string>()
  addPathAlias(root, aliases)
  return [...aliases].sort((left, right) => right.length - left.length)
}

function replaceRootPrefix(path: string, root: string, placeholder: '<artifact-root>' | '<project-root>'): string | null {
  if (path === root) {
    return placeholder
  }

  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`
  if (!path.startsWith(rootPrefix)) {
    return null
  }

  return `${placeholder}/${toPortableShareSafeSuffix(path.slice(rootPrefix.length))}`
}

function toShareSafeRootedPath(path: string, roots: ShareSafePathRoots): string | null {
  if (sameResolvedPath(path, roots.artifactRoot) || isWithinRoot(path, roots.artifactRoot)) {
    return replaceRootPrefix(resolve(path), resolve(roots.artifactRoot), '<artifact-root>') ?? '<artifact-root>'
  }
  for (const alias of rootAliases(roots.artifactRoot)) {
    const replaced = replaceRootPrefix(path, alias, '<artifact-root>')
    if (replaced !== null) return replaced
  }

  if (sameResolvedPath(path, roots.projectRoot) || isWithinRoot(path, roots.projectRoot)) {
    return replaceRootPrefix(resolve(path), resolve(roots.projectRoot), '<project-root>') ?? '<project-root>'
  }
  for (const alias of rootAliases(roots.projectRoot)) {
    const replaced = replaceRootPrefix(path, alias, '<project-root>')
    if (replaced !== null) return replaced
  }

  return null
}

function splitTrailingPathPunctuation(token: string): { path: string; suffix: string } {
  let end = token.length
  while (end > 0 && TRAILING_PATH_PUNCTUATION.has(token[end - 1] ?? '')) {
    end -= 1
  }
  return {
    path: token.slice(0, end),
    suffix: token.slice(end),
  }
}

function externalPathFallback(path: string): string {
  const normalizedPath = path.replaceAll('\\', '/')
  const lastSegment = normalizedPath.split('/').pop()
  return lastSegment && lastSegment.length > 0 ? lastSegment : '<external-path>'
}

export function toShareSafeArtifactPath(path: string, roots: ShareSafePathRoots): string {
  const rewrittenPath = toShareSafeRootedPath(path, roots)
  if (rewrittenPath !== null) return rewrittenPath
  return externalPathFallback(path)
}

export function sanitizeShareSafeText(text: string, roots: ShareSafePathRoots): string {
  return text.replace(ABSOLUTE_PATH_TOKEN_PATTERN, (token) => {
    const { path, suffix } = splitTrailingPathPunctuation(token)
    const rewrittenPath = toShareSafeRootedPath(path, roots)
    return rewrittenPath === null ? `${externalPathFallback(path)}${suffix}` : `${rewrittenPath}${suffix}`
  })
}
