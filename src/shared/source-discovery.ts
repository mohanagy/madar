import { relative, resolve, sep } from 'node:path'

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

const TEST_DOMAIN_RE = /(?:^|\/)(?:__tests__|tests?|spec|specs|e2e|cypress|playwright)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i
const BENCHMARK_DOMAIN_RE = /(?:^|\/)(?:bench|benchmark|benchmarks|perf|performance)(?:\/|$)|\.(?:bench|benchmark)\.[^/]+$/i
const FIXTURE_DOMAIN_RE = /(?:^|\/)(?:fixtures?|__fixtures__|mocks?|__mocks__)(?:\/|$)|\.fixture\.[^/]+$/i
const GENERATED_DOMAIN_RE = /(?:^|\/)(?:generated|__generated__)(?:\/|$)|\.(?:generated|gen)\.[^/]+$/i
const DOCS_DOMAIN_RE = /(?:^|\/)docs(?:\/|$)|\.(?:md|mdx|rst|txt)$/i
const CONFIG_DOMAIN_RE = /(?:^|\/)(?:config|configs?|settings)(?:\/|$)|(?:^|\/)\.env(?:\.[^/]+)?$|(?:^|\/)(?:package|tsconfig|vite|vitest|jest|eslint|prettier|rollup|webpack|babel|docker-compose|compose|pnpm-workspace|turbo|nx)\.(?:json|ya?ml|[cm]?js|ts|mjs|cjs)$/i
const BUILD_ARTIFACT_DOMAIN_RE = /(?:^|\/)(?:dist|build|out|coverage|\.next|\.nuxt|\.svelte-kit|\.astro|\.vite|\.turbo|\.nx|\.parcel-cache|\.cache|\.serverless|\.vercel|\.netlify)(?:\/|$)|\.(?:min\.(?:js|css)|map|tsbuildinfo|d\.ts\.map)$/i
const HARD_IGNORE_REGEXES: ReadonlyArray<RegExp> = [
  /(?:^|\/)\.(?:git|hg|svn|repo|jj)(?:\/|$)/i,
  /(?:^|\/)\.worktrees(?:\/|$)/i,
  /(?:^|\/)worktrees(?:\/|$)/i,
  /^lib\/.*(?:\.(?:js|cjs|mjs)|\.d\.ts)$/i,
  /(?:^|\/)(?:out|\.madar|madar-cache|madar-report)(?:\/|$)/i,
  /(?:^|\/)GRAPH_REPORT\.md$/i,
  /(?:^|\/)(?:node_modules|bower_components|vendor|dist|build|coverage|logs|tmp|temp)(?:\/|$)/i,
  /(?:^|\/)\.pnpm-store(?:\/|$)/i,
  /(?:^|\/)\.yarn\/(?:cache|unplugged)(?:\/|$)/i,
  /(?:^|\/)\.yarn\/build-state\.yml$/i,
  /(?:^|\/)(?:\.next|\.nuxt|\.svelte-kit|\.astro|\.vite|\.turbo|\.nx|\.parcel-cache|\.cache|\.serverless|\.vercel|\.netlify|\.nyc_output|\.test-artifacts)(?:\/|$)/i,
  /\.(?:min\.js|min\.css|map|tsbuildinfo|d\.ts\.map|log)$/i,
  /(?:^|\/)\.DS_Store$/i,
]

function normalizeSourcePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/{2,}/g, '/')
}

function relativeWorkspacePath(path: string, root: string): string | null {
  const normalizedRoot = normalizeSourcePath(root)
  const normalizedPath = normalizeSourcePath(path)
  if (/^[A-Za-z]:\//.test(normalizedPath)) {
    const rootPrefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`
    const lowerRoot = normalizedRoot.toLowerCase()
    const lowerPath = normalizedPath.toLowerCase()
    if (lowerPath === lowerRoot) return ''
    return lowerPath.startsWith(rootPrefix.toLowerCase()) ? normalizedPath.slice(rootPrefix.length) : null
  }

  const resolvedRoot = resolve(root)
  const resolvedPath = path.startsWith(sep) ? resolve(path) : resolve(resolvedRoot, path)
  const local = normalizeSourcePath(relative(resolvedRoot, resolvedPath))
  return local === '..' || local.startsWith('../') ? null : local
}

function workspaceAwarePath(path: string, root?: string): string {
  if (!root) return normalizeSourcePath(path)
  const local = relativeWorkspacePath(path, root)
  return local === null ? normalizeSourcePath(path) : normalizeSourcePath(local)
}

function isHardIgnoredPath(path: string): boolean {
  const normalized = normalizeSourcePath(path)
  return HARD_IGNORE_REGEXES.some((pattern) => pattern.test(normalized))
}

export function classifySourceDomain(path: string, root?: string): SourceDomain {
  const normalized = workspaceAwarePath(path, root).toLowerCase()
  if (!normalized) return 'unknown'
  if (isHardIgnoredPath(normalized) || BUILD_ARTIFACT_DOMAIN_RE.test(normalized)) return 'build_artifact'
  if (TEST_DOMAIN_RE.test(normalized)) return 'test'
  if (BENCHMARK_DOMAIN_RE.test(normalized)) return 'benchmark'
  if (FIXTURE_DOMAIN_RE.test(normalized)) return 'fixture'
  if (GENERATED_DOMAIN_RE.test(normalized)) return 'generated'
  if (DOCS_DOMAIN_RE.test(normalized)) return 'docs'
  if (CONFIG_DOMAIN_RE.test(normalized)) return 'config'
  return /\.[A-Za-z0-9]+$/i.test(normalized) ? 'production' : 'unknown'
}

export function isPollutedSourcePath(path: string, root?: string): boolean {
  return isHardIgnoredPath(workspaceAwarePath(path, root))
}
