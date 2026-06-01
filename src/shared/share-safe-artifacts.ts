import { existsSync, realpathSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

export interface ShareSafePathRoots {
  artifactRoot: string
  projectRoot: string
}

const URL_TOKEN_PATTERN = /(?<![A-Za-z0-9+./-])[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]+/gi
const FILE_URL_TOKEN_PATTERN = /file:\/\/[^\s"'`<>]+/gi
const ROOTED_LITERAL_SCHEME_SUFFIX_PATTERN = /(?:<artifact-root>|<project-root>)[^\n\r\t"'`<]*?:\/\/[^\s"'`<>]+/g
const PROTOCOL_RELATIVE_URL_TOKEN_PATTERN = /(?<!:)\/\/[^\s"'`<>]+/g
const PATH_SEGMENT_PATTERN = String.raw`[^\s"'<>\\/]+(?: [^\s"'<>\\/]+)*`
const ATTACHED_PATH_SEGMENT_PATTERN = String.raw`[^\s"'<>\\/,;:]+(?: [^\s"'<>\\/,;:]+)*`
const RELATIVE_TRAVERSAL_SEGMENT_PATTERN = ATTACHED_PATH_SEGMENT_PATTERN
const WINDOWS_DRIVE_PATH_PATTERN = String.raw`[A-Za-z]:[\\/](?:${PATH_SEGMENT_PATTERN}(?:[\\/]+${PATH_SEGMENT_PATTERN})*)?`
const WINDOWS_UNC_PATH_PATTERN = String.raw`\\\\${PATH_SEGMENT_PATTERN}(?:[\\/]+${PATH_SEGMENT_PATTERN})+`
const ATTACHED_WINDOWS_DRIVE_PATH_PATTERN = String.raw`[A-Za-z]:[\\/](?:${ATTACHED_PATH_SEGMENT_PATTERN}(?:[\\/]+${ATTACHED_PATH_SEGMENT_PATTERN})*)?`
const ATTACHED_WINDOWS_UNC_PATH_PATTERN = String.raw`\\\\${ATTACHED_PATH_SEGMENT_PATTERN}(?:[\\/]+${ATTACHED_PATH_SEGMENT_PATTERN})+`
const ABSOLUTE_PATH_TOKEN_PATTERN = new RegExp(
  String.raw`(?<!<artifact-root>)(?<!<project-root>)(?:${WINDOWS_DRIVE_PATH_PATTERN}|${WINDOWS_UNC_PATH_PATTERN}|\/(?:${PATH_SEGMENT_PATTERN}(?:[\\/]+${PATH_SEGMENT_PATTERN})*)?)`,
  'g',
)
const PUNCTUATION_ATTACHED_WINDOWS_PATH_PATTERN = new RegExp(
  String.raw`([,:;])(${ATTACHED_WINDOWS_DRIVE_PATH_PATTERN}|${ATTACHED_WINDOWS_UNC_PATH_PATTERN})`,
  'g',
)
const PUNCTUATION_ATTACHED_UNIX_PATH_PATTERN = new RegExp(
  String.raw`(?<!\b[A-Za-z])([,:;])(\/(?:${ATTACHED_PATH_SEGMENT_PATTERN}(?:[\\/]+${ATTACHED_PATH_SEGMENT_PATTERN})*)?)`,
  'g',
)
const RESTARTED_ABSOLUTE_PATH_PATTERN = new RegExp(
  String.raw`(?:\/\/(?:${PATH_SEGMENT_PATTERN}(?:[\\/]+${PATH_SEGMENT_PATTERN})*)?|\/[A-Za-z]:[\\/](?:${PATH_SEGMENT_PATTERN}(?:[\\/]+${PATH_SEGMENT_PATTERN})*)?)`,
  'g',
)
const RELATIVE_TRAVERSAL_TOKEN_PATTERN = new RegExp(
  String.raw`(?:\.\.[\\/]+)+(?:${RELATIVE_TRAVERSAL_SEGMENT_PATTERN}(?:[\\/]+${RELATIVE_TRAVERSAL_SEGMENT_PATTERN})*)?`,
  'g',
)
const TRAILING_PATH_PUNCTUATION = new Set([',', '.', ':', ';', ')', ']', '}'])
const WINDOWS_SHARE_SEGMENT_HINTS = new Set(['share', 'shares', 'users', 'homes', 'public', 'private', 'admin$', 'ipc$', 'print$'])
const SHARE_HOST_HINTS = new Set(['server', 'servers', 'file', 'files', 'nas', 'smb', 'share', 'storage', 'internal', 'intranet', 'corp'])
const URL_PATH_SEGMENT_HINTS = new Set(['assets', 'static', 'scripts', 'styles', 'images', 'img', 'fonts', 'media', 'docs', 'doc', 'api', 'blog'])
const URL_ASSET_EXTENSIONS = new Set(['js', 'mjs', 'cjs', 'css', 'map', 'json', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'woff', 'woff2', 'ttf', 'eot', 'html', 'htm', 'pdf', 'xml'])
const URL_PLACEHOLDER_PREFIX = '__MADAR_SHARE_SAFE_URL__'
const SENSITIVE_CREDENTIAL_NAME_PATTERN = /(?:^|[_-])(token|key|secret|password|pass|auth|authorization|signature|sig)(?:[_-]|$)/i
const REDACTION_SENTINEL = 'MADAR_SHARE_SAFE_REDACTED'

function isSensitiveCredentialName(name: string): boolean {
  const normalized = name.trim().toLowerCase().replace(/\[\]$/, '')
  return SENSITIVE_CREDENTIAL_NAME_PATTERN.test(normalized)
}

function redactCredentialLikeText(text: string): string {
  return text
    .replaceAll(/(^|[\s([{])([A-Z0-9_]+)=([^\s]+)/gim, (match, prefix: string, name: string) =>
      isSensitiveCredentialName(name) ? `${prefix}${name}=[REDACTED]` : match,
    )
    .replaceAll(/(Authorization:\s*)(Bearer|Basic)\s+[^\s]+/gi, '$1$2 [REDACTED]')
    .replaceAll(/(Bearer)\s+[^\s]+/gi, '$1 [REDACTED]')
}

function redactRemoteUrlSecrets(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }

  let changed = parsed.username.length > 0 || parsed.password.length > 0
  if (changed) {
    parsed.username = REDACTION_SENTINEL
    parsed.password = ''
  }

  const sensitiveQueryKeys = new Set<string>()
  for (const [key] of parsed.searchParams.entries()) {
    if (isSensitiveCredentialName(key)) {
      sensitiveQueryKeys.add(key)
    }
  }
  for (const key of sensitiveQueryKeys) {
    parsed.searchParams.set(key, REDACTION_SENTINEL)
    changed = true
  }

  if (!changed) {
    return url
  }

  return parsed.toString().replaceAll(REDACTION_SENTINEL, '[REDACTED]')
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

function candidatePathPrefixEnds(path: string): number[] {
  const ends = new Set<number>([path.length])
  for (let index = 0; index < path.length; index += 1) {
    const char = path[index]
    if (char === ' ' || TRAILING_PATH_PUNCTUATION.has(char ?? '')) {
      ends.add(index)
    }
    if (char === ':' && (path[index + 1] === '/' || /^[A-Za-z]:[\\/]/.test(path.slice(index + 1)))) {
      ends.add(index)
    }
    if ((char === '/' || char === '\\') && (path[index + 1] === char || /^[A-Za-z]:[\\/]/.test(path.slice(index + 1)))) {
      ends.add(index)
    }
  }
  return [...ends].sort((left, right) => right - left)
}

function findBestResolvedPrefix(
  path: string,
  resolvePrefix: (candidate: string) => string | null,
): { prefix: string; rewrite: string } | null {
  for (const end of candidatePathPrefixEnds(path)) {
    const candidate = path.slice(0, end)
    const rewrite = resolvePrefix(candidate)
    if (rewrite !== null) {
      return { prefix: candidate, rewrite }
    }
  }
  return null
}

function resolveShareSafePlaceholderPrefix(
  path: string,
  root: string,
  placeholder: '<artifact-root>' | '<project-root>',
): string | null {
  if (!path.startsWith('/')) {
    return null
  }

  const normalizedPath = path.replaceAll('\\', '/')
  if (
    normalizedPath.includes('//') ||
    /\/[A-Za-z]:\//.test(normalizedPath) ||
    /:(?:\/|[A-Za-z]:\/)/.test(normalizedPath)
  ) {
    return null
  }

  const resolvedPath = resolve(root, path.slice(1))
  const rewrittenPath = replaceRootPrefix(resolvedPath, resolve(root), placeholder)
  if (rewrittenPath === null) {
    return null
  }

  if (existsSync(resolvedPath) || !path.includes(' ') || looksLikeShareSafeMissingPath(path)) {
    return rewrittenPath
  }

  return null
}

function looksLikeShareSafeMissingPath(path: string): boolean {
  if (!path.startsWith('/')) {
    return false
  }

  const normalizedPath = path.slice(1).replaceAll('\\', '/')
  if (!normalizedPath.includes('/')) {
    return false
  }

  for (let index = 0; index < path.length; index += 1) {
    if (path[index] !== ' ') {
      continue
    }

    const nextSeparator = path.slice(index + 1).search(/[\\/]/)
    const nextSeparatorIndex = nextSeparator < 0 ? -1 : index + 1 + nextSeparator

    if (nextSeparatorIndex >= 0) {
      const segmentBeforeSeparator = path.slice(index + 1, nextSeparatorIndex)
      if (
        segmentBeforeSeparator.trim().length === 0 ||
        segmentBeforeSeparator.endsWith(' ') ||
        [...TRAILING_PATH_PUNCTUATION].some((punctuation) => segmentBeforeSeparator.includes(punctuation))
      ) {
        return false
      }
      continue
    }

    const segmentAfterSpace = path.slice(index + 1)
    if (segmentAfterSpace.length === 0) {
      return false
    }

    if (!segmentAfterSpace.includes('.')) {
      return false
    }
  }

  return true
}

function shareSafeRootedTokenEnd(text: string, offset: number, roots: ShareSafePathRoots): number | null {
  const artifactIndex = text.lastIndexOf('<artifact-root>', offset)
  const projectIndex = text.lastIndexOf('<project-root>', offset)
  const placeholderIndex = Math.max(artifactIndex, projectIndex)
  if (placeholderIndex < 0) {
    return null
  }

  const placeholder = artifactIndex > projectIndex ? '<artifact-root>' : '<project-root>'
  const root = placeholder === '<artifact-root>' ? roots.artifactRoot : roots.projectRoot
  const start = placeholderIndex + placeholder.length
  const hardBoundaryIndexes = [
    text.indexOf('\n', start),
    text.indexOf('\r', start),
    text.indexOf('\t', start),
    text.indexOf('"', start),
    text.indexOf("'", start),
    text.indexOf('`', start),
    text.indexOf('<', start),
  ].filter((index) => index >= 0)
  const hardBoundary = hardBoundaryIndexes.length === 0 ? text.length : Math.min(...hardBoundaryIndexes)
  const pathTail = text.slice(start, hardBoundary)
  const bestPrefix = findBestResolvedPrefix(pathTail, (candidate) =>
    resolveShareSafePlaceholderPrefix(candidate, root, placeholder),
  )
  if (bestPrefix === null) {
    return null
  }

  const tokenEnd = start + bestPrefix.prefix.length
  return offset >= start && offset < tokenEnd ? tokenEnd : null
}

export function toShareSafeArtifactPath(path: string, roots: ShareSafePathRoots): string {
  const rewrittenPath = toShareSafeRootedPath(path, roots)
  if (rewrittenPath !== null) return rewrittenPath
  return externalPathFallback(path)
}

function resolveRelativeTraversalPath(path: string, roots: ShareSafePathRoots): string | null {
  for (const candidate of [resolve(roots.projectRoot, path), resolve(roots.artifactRoot, path)]) {
    if (!existsSync(candidate)) continue

    const rewrittenPath = toShareSafeRootedPath(candidate, roots)
    if (rewrittenPath !== null) return rewrittenPath
  }

  return null
}

function sanitizeRelativeTraversalPath(path: string, roots: ShareSafePathRoots): string {
  const rewrittenPath = resolveRelativeTraversalPath(path, roots)
  if (rewrittenPath !== null) return rewrittenPath
  return externalPathFallback(path)
}

function sanitizeRelativeTraversalToken(token: string, roots: ShareSafePathRoots): string {
  const { path, suffix } = splitTrailingPathPunctuation(token)
  const bestPrefix = findBestResolvedPrefix(path, (candidate) => resolveRelativeTraversalPath(candidate, roots))
  if (bestPrefix !== null) {
    const trailingText = `${path.slice(bestPrefix.prefix.length)}${suffix}`
    return trailingText.length === 0 ? bestPrefix.rewrite : `${bestPrefix.rewrite}${sanitizeShareSafeText(trailingText, roots)}`
  }

  return `${sanitizeRelativeTraversalPath(path, roots)}${suffix}`
}

function sanitizeFileUrl(url: string, roots: ShareSafePathRoots): string {
  let path = url.slice('file://'.length)
  if (path.startsWith('localhost/')) {
    path = path.slice('localhost'.length)
  }
  if (path.startsWith('/') && /^[A-Za-z]:[\\/]/.test(path.slice(1))) {
    path = path.slice(1)
  }
  return `file://${toShareSafeArtifactPath(path, roots)}`
}

function looksLikeProtocolRelativeUrl(path: string): boolean {
  if (!path.startsWith('//')) {
    return false
  }

  return looksLikeLiteralSchemeSuffix(path.slice(2))
}

function looksLikeLiteralSchemeSuffix(suffix: string): boolean {
  const slashIndex = suffix.indexOf('/')
  const host = slashIndex >= 0 ? suffix.slice(0, slashIndex) : suffix
  if (!(host === 'localhost' || host.includes('.') || /^[^/]+:\d+$/.test(host))) {
    return false
  }
  const hostHint = host.split(/[.:]/, 1)[0]?.toLowerCase() ?? ''
  if (SHARE_HOST_HINTS.has(hostHint)) {
    return false
  }

  const pathSegments = (slashIndex >= 0 ? suffix.slice(slashIndex + 1) : '')
    .split('/')
    .filter((segment) => segment.length > 0)
  const rawFirstSegment = pathSegments[0] ?? ''
  const firstSegment = pathSegments[0]?.toLowerCase() ?? ''
  const firstLooksShareLike =
    WINDOWS_SHARE_SEGMENT_HINTS.has(firstSegment) ||
    firstSegment.endsWith('$') ||
    (/^[A-Z][A-Za-z0-9_$-]*$/.test(rawFirstSegment) && /\d/.test(hostHint))
  if (firstLooksShareLike) {
    return false
  }

  if (pathSegments.length <= 1) {
    return true
  }

  const lastSegment = pathSegments[pathSegments.length - 1] ?? ''
  const lastExtensionIndex = lastSegment.lastIndexOf('.')
  const lastExtension = lastExtensionIndex >= 0 ? lastSegment.slice(lastExtensionIndex + 1).toLowerCase() : ''
  if (URL_PATH_SEGMENT_HINTS.has(firstSegment) || URL_ASSET_EXTENSIONS.has(lastExtension)) {
    return true
  }
  if (hostHint === 'eng' && pathSegments.length >= 2) {
    return false
  }

  if (!lastSegment.includes('.')) {
    return pathSegments.length >= 2
  }
  return false
}

export function sanitizeShareSafeText(text: string, roots: ShareSafePathRoots): string {
  const redactedText = redactCredentialLikeText(text)
  const urls: string[] = []
  const fileProtectedText = redactedText.replace(FILE_URL_TOKEN_PATTERN, (url) => {
    const placeholder = `${URL_PLACEHOLDER_PREFIX}${urls.length}__`
    urls.push(sanitizeFileUrl(url, roots))
    return placeholder
  })
  const rootedSuffixProtectedText = fileProtectedText.replace(ROOTED_LITERAL_SCHEME_SUFFIX_PATTERN, (value) => {
    const schemeIndex = value.indexOf('://')
    const suffix = schemeIndex >= 0 ? value.slice(schemeIndex + 3) : ''
    if (!looksLikeLiteralSchemeSuffix(suffix)) {
      return value
    }
    const placeholder = `${URL_PLACEHOLDER_PREFIX}${urls.length}__`
    urls.push(value)
    return placeholder
  })
  const schemeProtectedText = rootedSuffixProtectedText.replace(URL_TOKEN_PATTERN, (url) => {
    const placeholder = `${URL_PLACEHOLDER_PREFIX}${urls.length}__`
    urls.push(redactRemoteUrlSecrets(url))
    return placeholder
  })
  const protectedText = schemeProtectedText.replace(PROTOCOL_RELATIVE_URL_TOKEN_PATTERN, (url) => {
    if (!looksLikeProtocolRelativeUrl(url)) {
      return url
    }
    const placeholder = `${URL_PLACEHOLDER_PREFIX}${urls.length}__`
    urls.push(url)
    return placeholder
  })

  const traversalSanitizedText = protectedText.replace(RELATIVE_TRAVERSAL_TOKEN_PATTERN, (token) =>
    sanitizeRelativeTraversalToken(token, roots),
  )
  const unixSanitizedText = traversalSanitizedText.replace(
    PUNCTUATION_ATTACHED_UNIX_PATH_PATTERN,
    (_match, punctuation: string, path: string) => `${punctuation}${toShareSafeArtifactPath(path, roots)}`,
  )
  const windowsSanitizedText = unixSanitizedText.replace(
    PUNCTUATION_ATTACHED_WINDOWS_PATH_PATTERN,
    (_match, punctuation: string, path: string) => `${punctuation}${toShareSafeArtifactPath(path, roots)}`,
  )
  const restartedPathSanitizedText = windowsSanitizedText.replace(
    RESTARTED_ABSOLUTE_PATH_PATTERN,
    (match) => (looksLikeProtocolRelativeUrl(match) ? match : `/${toShareSafeArtifactPath(match.slice(1), roots)}`),
  )

  const sanitizedText = restartedPathSanitizedText.replace(ABSOLUTE_PATH_TOKEN_PATTERN, (token, offset, source) => {
    const rootedTokenEnd = shareSafeRootedTokenEnd(source, offset, roots)
    if (rootedTokenEnd !== null) {
      const protectedLength = rootedTokenEnd - offset
      let protectedPrefix = token.slice(0, protectedLength)
      let trailingSuffix = token.slice(protectedLength)
      if (trailingSuffix.startsWith('://') && looksLikeLiteralSchemeSuffix(trailingSuffix.slice(3))) {
        return `${protectedPrefix}${trailingSuffix}`
      }
      if (protectedPrefix.endsWith(':') && looksLikeProtocolRelativeUrl(trailingSuffix)) {
        return `${protectedPrefix}${trailingSuffix}`
      }
      if (/^[\\/]/.test(trailingSuffix) && /[A-Za-z]:$/.test(protectedPrefix)) {
        protectedPrefix = protectedPrefix.slice(0, -2)
        trailingSuffix = `${token.slice(protectedLength - 2, protectedLength)}${trailingSuffix}`
      }
      if (trailingSuffix.startsWith('//') || /^\/[A-Za-z]:[\\/]/.test(trailingSuffix)) {
        protectedPrefix = `${protectedPrefix}/`
        trailingSuffix = trailingSuffix.slice(1)
      }
      return trailingSuffix.length === 0 ? protectedPrefix : `${protectedPrefix}${sanitizeShareSafeText(trailingSuffix, roots)}`
    }
    const { path, suffix } = splitTrailingPathPunctuation(token)
    const rewrittenPath = toShareSafeRootedPath(path, roots)
    return rewrittenPath === null ? `${externalPathFallback(path)}${suffix}` : `${rewrittenPath}${suffix}`
  })

  return sanitizedText.replace(new RegExp(`${URL_PLACEHOLDER_PREFIX}(\\d+)__`, 'g'), (_placeholder, index) => {
    return urls[Number(index)] ?? ''
  })
}
