import { posix } from 'node:path'
import type { RetrievalExcludedDomain } from '../contracts/retrieval-gate.js'
import { CODE_EXTENSIONS, DOC_EXTENSIONS, UNSUPPORTED_SOURCE_EXTENSIONS } from '../shared/source-extensions.js'

const FILE_SUFFIXES = new Set([...CODE_EXTENSIONS, ...DOC_EXTENSIONS, ...UNSUPPORTED_SOURCE_EXTENSIONS, '.json', '.yaml', '.yml', '.toml', '.mdx'])
export const unquoteSourceExclusionOperand = (value: string): string => /^([`"']).*\1$/s.test(value.trim()) ? value.trim().slice(1, -1) : value.trim()

/** Preserve explicit path syntax, including unsupported patterns that must fail closed. */
export function sourceExclusionPathOperand(value: string): boolean {
  const clean = unquoteSourceExclusionOperand(value)
  if (!clean || (/\s/.test(clean) && clean === value.trim())) return false
  return /[/\\*?\[\]{}]/.test(clean) || clean.startsWith('.') || FILE_SUFFIXES.has(posix.extname(clean).toLowerCase())
}

export const EXCLUDED_DOMAIN_HINTS: ReadonlyArray<{ domain: RetrievalExcludedDomain; pattern: RegExp; pathHints: string[] }> = [
  { domain: 'test', pattern: /\b(?:tests?|specs?|coverage|__tests__|e2e|cypress|playwright)\b/i, pathHints: ['test', 'tests', '__tests__', 'spec', 'specs', 'coverage'] },
  { domain: 'benchmark', pattern: /\b(?:bench(?:mark|marks)?|performance|perf)\b/i, pathHints: ['bench', 'benchmark', 'benchmarks', 'perf', 'performance'] },
  { domain: 'fixture', pattern: /\b(?:fixtures?|mocks?|__fixtures__|__mocks__)\b/i, pathHints: ['fixture', 'fixtures', 'mock', 'mocks', '__fixtures__', '__mocks__'] },
  { domain: 'generated', pattern: /\b(?:generated|codegen|__generated__)\b/i, pathHints: ['generated', '__generated__'] },
  { domain: 'docs', pattern: /\b(?:docs?|readme|changelog|markdown|mdx?)\b/i, pathHints: ['docs', 'readme', 'changelog'] },
  { domain: 'config', pattern: /\b(?:config|configs?|settings|env|docker|compose|k8s|helm|package\.json|tsconfig)\b/i, pathHints: ['config', 'configs', 'settings', 'env', 'docker', 'compose', 'k8s', 'helm', 'package.json', 'tsconfig'] },
  { domain: 'build_artifact', pattern: /\b(?:build artifacts?|dist|coverage|out|node_modules)\b/i, pathHints: ['build', 'dist', 'coverage', 'out', 'node_modules'] },
]
const ARTIFACT_OPERAND_PATTERNS = EXCLUDED_DOMAIN_HINTS.map(({ pattern }) => new RegExp(`^(?:${pattern.source})$`, pattern.flags))

/** Code-shaped names are whole identifiers, not independent concept words. */
export function sourceExclusionSymbolOperand(value: string): string | undefined {
  if (sourceExclusionPathOperand(value)) return undefined
  const operand = unquoteSourceExclusionOperand(value)
  const clean = operand.replace(/\(\)$/, '')
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(clean)) return undefined
  // Bare artifact names retain domain semantics, including README and __tests__.
  // Explicit calls such as config() still name a symbol.
  if (!/\(\)$/.test(operand) && ARTIFACT_OPERAND_PATTERNS.some(pattern => pattern.test(clean))) return undefined
  return /[a-z][A-Z]|[_.$]/.test(clean) || /^[A-Z][A-Z0-9]+$/.test(clean) || /\(\)$/.test(operand)
    ? clean : undefined
}
