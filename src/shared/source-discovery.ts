import { basename, relative, resolve, sep } from 'node:path'
import { readFileSync } from 'node:fs'

export type SourceDomain =
  | 'production'
  | 'test'
  | 'benchmark'
  | 'fixture'
  | 'generated'
  | 'docs'
  | 'config'
  | 'build_artifact'
  | 'unknown'

export const DEFAULT_HARD_IGNORE_GLOBS = [
  '**/.git/**',
  '**/.hg/**',
  '**/.svn/**',
  '**/.worktrees/**',
  '**/worktrees/**',
  '**/.repo/**',
  '**/.jj/**',
  '**/out/**',
  '**/.sadeem/**',
  '**/sadeem-cache/**',
  '**/sadeem-report/**',
  '**/GRAPH_REPORT.md',
  '**/node_modules/**',
  '**/.pnpm-store/**',
  '**/.yarn/cache/**',
  '**/.yarn/unplugged/**',
  '**/.yarn/build-state.yml',
  '**/bower_components/**',
  '**/vendor/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/lib/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.svelte-kit/**',
  '**/.astro/**',
  '**/.vite/**',
  '**/.turbo/**',
  '**/.nx/**',
  '**/.parcel-cache/**',
  '**/.cache/**',
  '**/.serverless/**',
  '**/.vercel/**',
  '**/.netlify/**',
  '**/coverage/**',
  '**/.nyc_output/**',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/*.tsbuildinfo',
  '**/*.d.ts.map',
  '**/*.log',
  '**/logs/**',
  '**/tmp/**',
  '**/temp/**',
  '**/.DS_Store',
] as const

const TEST_DOMAIN_RE = /(?:^|\/)(?:__tests__|tests?|spec|specs|e2e|cypress|playwright)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i
const BENCHMARK_DOMAIN_RE = /(?:^|\/)(?:bench|benchmark|benchmarks|perf|performance)(?:\/|$)|\.(?:bench|benchmark)\.[^/]+$/i
const FIXTURE_DOMAIN_RE = /(?:^|\/)(?:fixtures?|__fixtures__|mocks?|__mocks__)(?:\/|$)|\.fixture\.[^/]+$/i
const GENERATED_DOMAIN_RE = /(?:^|\/)(?:generated|__generated__)(?:\/|$)|\.(?:generated|gen)\.[^/]+$/i
const DOCS_DOMAIN_RE = /(?:^|\/)docs(?:\/|$)|\.(?:md|mdx|rst|txt)$/i
const CONFIG_DOMAIN_RE = /(?:^|\/)(?:config|configs?|settings)(?:\/|$)|(?:^|\/)\.env(?:\.[^/]+)?$|(?:^|\/)(?:package|tsconfig|vite|vitest|jest|eslint|prettier|rollup|webpack|babel|docker-compose|compose|pnpm-workspace|turbo|nx)\.(?:json|ya?ml|[cm]?js|ts|mjs|cjs)$/i
const BUILD_ARTIFACT_DOMAIN_RE = /(?:^|\/)(?:dist|build|out|coverage|out|\.next|\.nuxt|\.svelte-kit|\.astro|\.vite|\.turbo|\.nx|\.parcel-cache|\.cache|\.serverless|\.vercel|\.netlify)(?:\/|$)|\.(?:min\.(?:js|css)|map|tsbuildinfo|d\.ts\.map)$/i
const HARD_IGNORE_REGEXES: ReadonlyArray<RegExp> = [
  /(?:^|\/)\.(?:git|hg|svn|repo|jj)(?:\/|$)/i,
  /(?:^|\/)\.worktrees(?:\/|$)/i,
  /(?:^|\/)worktrees(?:\/|$)/i,
  /(?:^|\/)(?:out|\.sadeem|sadeem-cache|sadeem-report)(?:\/|$)/i,
  /(?:^|\/)GRAPH_REPORT\.md$/i,
  /(?:^|\/)(?:node_modules|bower_components|vendor|dist|build|out|lib|coverage|logs|tmp|temp)(?:\/|$)/i,
  /(?:^|\/)\.pnpm-store(?:\/|$)/i,
  /(?:^|\/)\.yarn\/(?:cache|unplugged)(?:\/|$)/i,
  /(?:^|\/)\.yarn\/build-state\.yml$/i,
  /(?:^|\/)(?:\.next|\.nuxt|\.svelte-kit|\.astro|\.vite|\.turbo|\.nx|\.parcel-cache|\.cache|\.serverless|\.vercel|\.netlify|\.nyc_output|\.test-artifacts)(?:\/|$)/i,
  /\.(?:min\.js|min\.css|map|tsbuildinfo|d\.ts\.map|log)$/i,
  /(?:^|\/)\.DS_Store$/i,
]

function normalizePathLike(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/{2,}/g, '/')
}

function globToRegExp(pattern: string): RegExp {
  const wildcardCount = [...pattern].filter((character) => character === '*').length
  if (pattern.length > 512 || wildcardCount > 32) {
    return /^$/
  }

  const globstarSegmentToken = '\u0000'
  const globstarToken = '\u0001'
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const wildcarded = escaped
    .replace(/\*\*\//g, globstarSegmentToken)
    .replace(/\*\*/g, globstarToken)
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replaceAll(globstarSegmentToken, '(?:.*/)?')
    .replaceAll(globstarToken, '.*')
  return new RegExp(`^${wildcarded}$`)
}

function matchesPatternValue(value: string, pattern: string): boolean {
  return globToRegExp(pattern).test(value)
}

function relativeWorkspacePath(path: string, root: string): string | null {
  const normalizedRoot = normalizePathLike(root)
  const normalizedPath = normalizePathLike(path)
  const windowsAbsoluteRoot = /^[A-Za-z]:\//.test(normalizedRoot)
  const windowsAbsolutePath = /^[A-Za-z]:\//.test(normalizedPath)
  if (windowsAbsoluteRoot || windowsAbsolutePath) {
    const rootPrefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`
    const lowerRoot = normalizedRoot.toLowerCase()
    const lowerRootPrefix = rootPrefix.toLowerCase()
    const lowerPath = normalizedPath.toLowerCase()
    if (lowerPath === lowerRoot) {
      return ''
    }
    return lowerPath.startsWith(lowerRootPrefix)
      ? normalizedPath.slice(rootPrefix.length)
      : null
  }

  const resolvedRoot = resolve(root)
  const resolvedPath = path.startsWith(sep) ? resolve(path) : resolve(resolvedRoot, path)
  const relativePath = normalizePathLike(relative(resolvedRoot, resolvedPath))
  return relativePath.startsWith('..') ? null : relativePath
}

function matchesWorkspacePattern(relativePath: string, originalPath: string, pattern: string): boolean {
  const normalizedPattern = pattern.replace(/^!/, '').replace(/^\/+|\/+$/g, '')
  if (!normalizedPattern) {
    return false
  }

  const fileName = basename(originalPath)
  if (matchesPatternValue(relativePath, normalizedPattern) || matchesPatternValue(fileName, normalizedPattern)) {
    return true
  }

  const pathParts = relativePath.split('/')
  for (let index = 0; index < pathParts.length; index += 1) {
    const part = pathParts[index]
    if (!part) {
      continue
    }
    const prefix = pathParts.slice(0, index + 1).join('/')
    if (matchesPatternValue(part, normalizedPattern) || matchesPatternValue(prefix, normalizedPattern)) {
      return true
    }
  }

  return false
}

export function normalizeSourcePath(path: string): string {
  return normalizePathLike(path)
}

function workspaceAwarePath(path: string, root?: string): string {
  if (!root) {
    return normalizeSourcePath(path)
  }

  const relativePath = relativeWorkspacePath(path, root)
  return relativePath ? normalizeSourcePath(relativePath) : normalizeSourcePath(path)
}

export function isHardIgnoredPath(path: string): boolean {
  const normalizedPath = normalizeSourcePath(path)
  return HARD_IGNORE_REGEXES.some((pattern) => pattern.test(normalizedPath))
}

export function isDiscoveryPathIgnored(path: string, root: string, patterns: readonly string[]): boolean {
  const relativePath = relativeWorkspacePath(path, root)
  if (!relativePath) {
    return false
  }

  let ignored = isHardIgnoredPath(relativePath)
  for (const rawPattern of patterns) {
    const pattern = rawPattern.trim()
    if (!pattern) {
      continue
    }
    const negated = pattern.startsWith('!')
    if (matchesWorkspacePattern(relativePath, path, pattern)) {
      ignored = !negated
    }
  }
  return ignored
}

export function isIgnoredByPatterns(path: string, root: string, patterns: readonly string[]): boolean {
  const relativePath = relativeWorkspacePath(path, root)
  if (!relativePath) {
    return false
  }

  let ignored = false
  for (const rawPattern of patterns) {
    const pattern = rawPattern.trim()
    if (!pattern) {
      continue
    }
    const negated = pattern.startsWith('!')
    if (matchesWorkspacePattern(relativePath, path, pattern)) {
      ignored = !negated
    }
  }
  return ignored
}

export function loadSadeemignorePatterns(root: string): string[] {
  try {
    const content = readFileSync(resolve(root, '.sadeemignore'), 'utf8')
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
  } catch {
    return []
  }
}

export function classifySourceDomain(path: string, root?: string): SourceDomain {
  const normalizedPath = workspaceAwarePath(path, root).toLowerCase()
  if (!normalizedPath) {
    return 'unknown'
  }
  if (isHardIgnoredPath(normalizedPath)) {
    return 'build_artifact'
  }
  if (BUILD_ARTIFACT_DOMAIN_RE.test(normalizedPath)) {
    return 'build_artifact'
  }
  if (TEST_DOMAIN_RE.test(normalizedPath)) {
    return 'test'
  }
  if (BENCHMARK_DOMAIN_RE.test(normalizedPath)) {
    return 'benchmark'
  }
  if (FIXTURE_DOMAIN_RE.test(normalizedPath)) {
    return 'fixture'
  }
  if (GENERATED_DOMAIN_RE.test(normalizedPath)) {
    return 'generated'
  }
  if (DOCS_DOMAIN_RE.test(normalizedPath)) {
    return 'docs'
  }
  if (CONFIG_DOMAIN_RE.test(normalizedPath)) {
    return 'config'
  }
  return /\.[A-Za-z0-9]+$/i.test(normalizedPath) ? 'production' : 'unknown'
}

export function isPollutedSourcePath(path: string, root?: string): boolean {
  const normalizedPath = workspaceAwarePath(path, root)
  return isHardIgnoredPath(normalizedPath)
}
