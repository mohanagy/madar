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

const TEST_RE = /(?:^|\/)(?:__tests__|tests?|spec|specs|e2e|cypress|playwright)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i
const BENCHMARK_RE = /(?:^|\/)(?:bench|benchmark|benchmarks|perf|performance)(?:\/|$)|\.(?:bench|benchmark)\.[^/]+$/i
const FIXTURE_RE = /(?:^|\/)(?:fixtures?|__fixtures__|mocks?|__mocks__)(?:\/|$)|\.fixture\.[^/]+$/i
const GENERATED_RE = /(?:^|\/)(?:generated|__generated__)(?:\/|$)|\.(?:generated|gen)\.[^/]+$/i
const DOCS_RE = /(?:^|\/)docs(?:\/|$)|\.(?:md|mdx|rst|txt)$/i
const CONFIG_RE = /(?:^|\/)(?:config|configs?|settings)(?:\/|$)|(?:^|\/)\.env(?:\.[^/]+)?$|(?:^|\/)(?:package|tsconfig|vite|vitest|jest|eslint|prettier|rollup|webpack|babel|docker-compose|compose|pnpm-workspace|turbo|nx)\.(?:json|ya?ml|[cm]?js|ts|mjs|cjs)$/i
const BUILD_RE = /(?:^|\/)(?:dist|build|out|coverage|\.next|\.nuxt|\.svelte-kit|\.astro|\.vite|\.turbo|\.nx|\.parcel-cache|\.cache|\.serverless|\.vercel|\.netlify)(?:\/|$)|\.(?:min\.(?:js|css)|map|tsbuildinfo|d\.ts\.map)$/i
const HARD_IGNORE = [
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
] as const

const slash = (value: string): string => value.replaceAll('\\', '/').replace(/\/{2,}/g, '/')

function workspacePath(path: string, root?: string): string {
  if (!root) return slash(path)
  const normalizedPath = slash(path)
  const normalizedRoot = slash(root)
  if (/^[A-Za-z]:\//.test(normalizedPath)) {
    const prefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`
    return normalizedPath.toLowerCase().startsWith(prefix.toLowerCase())
      ? normalizedPath.slice(prefix.length)
      : normalizedPath
  }
  const rootPath = resolve(root)
  const absolutePath = path.startsWith(sep) ? resolve(path) : resolve(rootPath, path)
  const local = slash(relative(rootPath, absolutePath))
  return local === '..' || local.startsWith('../') ? normalizedPath : local
}

function isHardIgnored(path: string): boolean {
  const normalized = slash(path)
  return HARD_IGNORE.some((pattern) => pattern.test(normalized))
}

export function classifySourceDomain(path: string, root?: string): SourceDomain {
  const normalized = workspacePath(path, root).toLowerCase()
  if (!normalized) return 'unknown'
  if (isHardIgnored(normalized) || BUILD_RE.test(normalized)) return 'build_artifact'
  if (TEST_RE.test(normalized)) return 'test'
  if (BENCHMARK_RE.test(normalized)) return 'benchmark'
  if (FIXTURE_RE.test(normalized)) return 'fixture'
  if (GENERATED_RE.test(normalized)) return 'generated'
  if (DOCS_RE.test(normalized)) return 'docs'
  if (CONFIG_RE.test(normalized)) return 'config'
  return /\.[A-Za-z0-9]+$/i.test(normalized) ? 'production' : 'unknown'
}

export function sourceDomainOf(
  value: unknown,
  path: string,
  root?: string,
): SourceDomain {
  return typeof value === 'string' && [
    'production', 'test', 'benchmark', 'fixture', 'generated', 'docs', 'config',
    'build_artifact', 'unknown',
  ].includes(value)
    ? value as SourceDomain
    : classifySourceDomain(path, root)
}

export function isPollutedSourcePath(path: string, root?: string): boolean {
  return isHardIgnored(workspacePath(path, root))
}
