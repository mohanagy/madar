export interface SourceSymbolOccurrence { name: string; start: number; end: number; explicit: boolean }

/** Complete lexemes preserve member identity; explicit syntax belongs to its occurrence. */
export function sourceQuerySymbols(question: string, options: { includeImplicit?: boolean } = {}): SourceSymbolOccurrence[] {
  const pathRanges = [...question.matchAll(/\b(?:https?|file):\/\/[^\s<>"'`]+|(?:\.{1,2}[\\/]|[\\/])?(?:[A-Za-z0-9_$@#.-]+[\\/])+[A-Za-z0-9_$@#.-]+/g)]
    .map(match => ({ start: match.index, end: match.index + match[0].length }))
  const result: SourceSymbolOccurrence[] = []
  const pattern = /(?<![A-Za-z0-9_$#./\\@:-])#?[A-Za-z_$][\w$]*(?:[ \t]*\.[ \t]*#?[A-Za-z_$][\w$]*)*(?![A-Za-z0-9_$#\/\\@-]|\.(?=[ \t]*#?[A-Za-z_$]))/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(question)) !== null) {
    const start = match.index
    let raw = match[0], end = start + raw.length
    if (pathRanges.some(range => start < range.end && end > range.start)) continue
    const before = question.slice(0, start)
    const markedAt = (after: string): boolean => {
      const quote = before.at(-1)
      return ((quote === '`' || quote === '"' || quote === "'") && new RegExp(`^(?:\\(\\))?${quote}`).test(after))
        || /^[ \t]*\(/.test(after) || /\b(?:function|method|symbol)\s+[`"']?$/i.test(before)
    }
    // Without code syntax, a spaced period can be sentence punctuation. Keep
    // its contiguous prefix and resume there; do not swallow the next sentence.
    // A contiguous qualified reference remains one atomic lexeme.
    if (/[ \t]+\.|\.[ \t]+/.test(raw) && !markedAt(question.slice(end))) {
      raw = /^#?[A-Za-z_$][\w$]*(?:\.#?[A-Za-z_$][\w$]*)*/.exec(raw)![0]
      end = start + raw.length
      pattern.lastIndex = end
    }
    const name = raw.replace(/[ \t]*\.[ \t]*/g, '.')
    const after = question.slice(end)
    // HTTP verbs in prose describe behavior shared by many route handlers.
    // Call syntax, quoting, qualification or a standalone lookup can still
    // explicitly request a declaration named POST (or another method).
    const httpMethod = /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|CONNECT|OPTIONS|TRACE)$/.test(name)
    const codeShaped = !httpMethod && /[_$#.]|[a-z][A-Z]|^[A-Z]/.test(name)
    const standalone = /^(?:please\s+)?(?:how\s+(?:does|do)|explain|show|find|locate|describe|change|update|fix)\s+(?:the\s+)?(?:(?:implementation|source|definition)\s+of\s+)?$/i.test(before)
      && /^[.!?]?\s*$/.test(after)
    const explicit = codeShaped || markedAt(after) || standalone
    if (explicit || options.includeImplicit) result.push({ name, start, end, explicit })
  }
  return result
}
