import { posix } from 'node:path'

import { tokenizeLabel } from './retrieve/pipeline.js'

import { sourceExclusionPathOperand, sourceExclusionSymbolOperand, unquoteSourceExclusionOperand as unquote } from './source-exclusion-paths.js'
export { sourceExclusionPathOperand } from './source-exclusion-paths.js'

const normalize = (value: string): string => value.replaceAll('\\', '/').replace(/\/{2,}/g, '/')
const absolute = (value: string): boolean => value.startsWith('/') || /^[A-Za-z]:\//.test(value)
const pathHint = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

type GlobState = { kind: 'literal'; value: string } | { kind: 'star' | 'globstar' | 'one' | 'directory-start' | 'directory-loop' }
const MAX_GLOB_INPUT_LENGTH = 4096
const MAX_GLOB_STATE_WORK = 262144

// Same wildcard grammar as discovery, compiled into a forward-only NFA.
function compilePattern(pattern: string): GlobState[] {
  const states: GlobState[] = []
  for (let index = 0; index < pattern.length;) {
    if (pattern[index] === '*') {
      let end = index + 1
      while (pattern[end] === '*') end++
      // Discovery recognizes the final **/ before pairing a longer star run.
      const directory = end - index >= 2 && pattern[end] === '/'
      const plainEnd = directory ? end - 2 : end
      while (index < plainEnd) {
        const pair = plainEnd - index >= 2
        states.push({ kind: pair ? 'globstar' : 'star' }); index += pair ? 2 : 1
      }
      if (directory) {
        states.push({ kind: 'directory-start' }, { kind: 'directory-loop' }); index = end + 1
      }
    } else {
      const value = pattern[index++]!
      states.push(value === '?' ? { kind: 'one' } : { kind: 'literal', value })
    }
  }
  return states
}

/** Undefined refuses work beyond the bound; callers treat it as excluded. */
function matchesPattern(states: readonly GlobState[], value: string, directoryPrefix = false): boolean | undefined {
  if (value.length > MAX_GLOB_INPUT_LENGTH || (states.length + 1) * (value.length + 1) > MAX_GLOB_STATE_WORK) return undefined
  let active = new Uint8Array(states.length + 1), next = new Uint8Array(states.length + 1)
  const close = (set: Uint8Array): void => {
    for (let index = 0; index < states.length; index++) {
      if (!set[index]) continue
      const kind = states[index]!.kind
      if (kind === 'star' || kind === 'globstar') set[index + 1] = 1
      else if (kind === 'directory-start') set[index + 2] = 1
    }
  }
  active[0] = 1; close(active)
  for (let offset = 0; offset < value.length; offset++) {
    const character = value[offset]!
    if (directoryPrefix && character === '/' && active[states.length]) return true
    next.fill(0)
    for (let index = 0; index < states.length; index++) {
      if (!active[index]) continue
      const state = states[index]!
      switch (state.kind) {
        case 'literal': if (character === state.value) next[index + 1] = 1; break
        case 'one': if (character !== '/') next[index + 1] = 1; break
        case 'star': if (character !== '/') next[index] = 1; break
        case 'globstar': next[index] = 1; break
        case 'directory-start':
          next[index + 1] = 1
          if (character === '/') next[index + 2] = 1
          break
        case 'directory-loop':
          next[index] = 1
          if (character === '/') next[index + 1] = 1
          break
      }
    }
    close(next)
    const prior = active; active = next; next = prior
  }
  return active[states.length] === 1
}

/** Lexical only: callers retain responsibility for canonical reads and policy checks. */
function localPath(value: string, root?: string): string | undefined {
  const clean = normalize(value)
  if (!clean || /[\u0000-\u001f\u007f]/.test(clean) || clean.split('/').includes('..')) return undefined
  if (!absolute(clean)) return clean.split('/').filter(part => part && part !== '.').join('/') || undefined
  if (!root) return undefined
  const base = normalize(root).replace(/\/$/, '')
  const windows = /^[A-Za-z]:\//.test(base)
  const comparable = windows ? clean.toLowerCase() : clean
  const prefix = `${windows ? base.toLowerCase() : base}/`
  return comparable.startsWith(prefix) ? clean.slice(prefix.length).split('/').filter(part => part && part !== '.').join('/') : undefined
}

interface PathScope { pattern: string; absolute: boolean; matcher: GlobState[]; directory: boolean; basename: boolean }

export interface CompiledSourceExclusions {
  valid: boolean
  matchesPath(sourceFile: string, sourceRoot?: string): boolean
  matchesLabel(label: string): boolean
  matchesText(text: string): boolean
  matchesSource(sourceFile: string, label?: string, sourceRoot?: string): boolean
}

/** Compile once per request; filenames and path patterns never enter word matching. */
export function compileSourceExclusions(
  excludedTerms: readonly string[], excludedPathHints: readonly string[], rootPath?: string,
): CompiledSourceExclusions {
  const scopes: PathScope[] = [], generic: string[] = [], derivedHints = new Set<string>()
  const symbols: RegExp[] = []
  let valid = true
  for (const raw of excludedTerms) {
    const symbol = sourceExclusionSymbolOperand(raw)
    if (symbol) {
      symbols.push(new RegExp(`(?<![A-Za-z0-9_$])${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_$])`, 'i'))
      derivedHints.add(pathHint(symbol))
      continue
    }
    if (!sourceExclusionPathOperand(raw)) {
      generic.push(raw)
      // This spelling is an alias of the whole operand, not another exclusion.
      derivedHints.add(pathHint(raw))
      continue
    }
    const term = normalize(unquote(raw))
    derivedHints.add(pathHint(term))
    // Match only the existing simple glob grammar; never reduce unsupported
    // traversal, negation, brace or extglob operands to a few generic words.
    if (term.length > 512 || [...term].filter(char => char === '*').length > 32
      || /[\u0000-\u001f\u007f!{}[\]()]|(?<!^[A-Za-z]):/.test(term)
      || term.split('/').includes('..') || /[`"']/.test(term)) { valid = false; continue }
    const isAbsolute = absolute(term)
    const pattern = isAbsolute && rootPath ? localPath(term, rootPath) : term.split('/').filter(part => part !== '.').join('/').replace(/\/$/, '')
    if (!pattern || pattern === '.' || pattern === '/') { valid = false; continue }
    scopes.push({ pattern, absolute: isAbsolute && !rootPath, matcher: compilePattern(pattern),
      directory: term.endsWith('/') || (term.includes('/') && !posix.extname(pattern)), basename: !pattern.includes('/') })
  }
  for (const hint of excludedPathHints) {
    if (!derivedHints.has(pathHint(unquote(hint)))) generic.push(hint)
  }
  const operands = generic.map(tokenizeLabel)
  if (operands.some(words => !words.length)) valid = false
  // OR applies between operands. A compound excludes its complete ordered
  // token sequence, not unrelated source mentioning either constituent word.
  const phrases = [...new Set(operands.map(words => ` ${words.join(' ')} `))]
  const matchesWords = (value: string): boolean => {
    const text = ` ${tokenizeLabel(value).join(' ')} `
    return phrases.some(phrase => text.includes(phrase))
  }
  const matchesLabel = (label: string): boolean => !valid || matchesWords(label) || symbols.some(pattern => pattern.test(label))
  const matchesPath = (sourceFile: string, sourceRoot = rootPath): boolean => {
    if (!valid) return true
    const local = localPath(sourceFile, sourceRoot)
    // Preserve generic matching against repository-relative paths when a root
    // is available; never let an ancestor directory become a source filter.
    if (matchesWords(local ?? sourceFile)) return true
    if (!scopes.length) return false
    const normalized = normalize(sourceFile)
    for (const scope of scopes) {
      if (scope.absolute) {
        if (!absolute(normalized)) return true
        if (matchesPattern(scope.matcher, normalized) !== false) return true
        continue
      }
      const candidate = local ?? (!sourceRoot ? normalized.replace(/^\//, '') : undefined)
      if (!candidate) return true
      if (matchesPattern(scope.matcher, scope.basename ? posix.basename(candidate) : candidate) !== false) return true
      if (scope.directory && matchesPattern(scope.matcher, candidate, true) !== false) return true
    }
    return false
  }
  return { valid, matchesPath, matchesLabel, matchesText: matchesLabel,
    matchesSource: (sourceFile, label, sourceRoot) => matchesPath(sourceFile, sourceRoot) || (label !== undefined && matchesLabel(label)) }
}
