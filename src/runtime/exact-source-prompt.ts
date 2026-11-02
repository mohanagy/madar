import type { ExplicitSourceTarget } from './explicit-source-targets.js'
import { requestedSourceSymbols } from './source-symbol-completion.js'

/** Recognize an explicit lookup instruction, never infer owners from broad prose. */
export function exactSourcePromptTargets(prompt: string): ExplicitSourceTarget[] | undefined {
  if (/^\s*(?:```|~~~)/m.test(prompt)) return undefined
  const symbol = '[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*'
  const match = new RegExp('^\\s*Exact source function\\s+[`"\']?\\.?(' + symbol
    + ')(?:\\(\\))?[`"\']?\\s+in\\s+[`"\']?([^\\s`"\']+?\\.[cm]?[jt]sx?)[`"\']?'
    + '(?:\\s+and\\s+[`"\']?(' + symbol + ')(?:\\(\\))?[`"\']?\\s+definition)?'
    + '(?:\\.(?:\\s+|$)|\\s*$)([\\s\\S]*)$', 'i').exec(prompt)
  if (!match) return undefined
  const tail = match[4] ?? ''
  // Additional named owners or file operands would make this scope incomplete.
  if (requestedSourceSymbols(tail).length || /\b[^\s]+\.[cm]?[jt]sx?\b/i.test(tail)) return undefined
  return [match[1]!, ...(match[3] ? [match[3]] : [])]
    .map(name => ({ file: match[2]!, symbol: name }))
}
