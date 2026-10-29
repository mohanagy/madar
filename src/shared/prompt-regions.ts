/** Pragmatic prompt data regions, not a complete Markdown parser.
 * Offsets are end-exclusive UTF-16. Top-level fences take precedence; inline
 * code and balanced quoted strings then own their contents in source order.
 * Unmatched inline/quote delimiters remain ordinary text. */
export interface PromptRegion {
  kind: 'fenced_example' | 'inline_code' | 'quoted_string'
  start: number
  end: number
}

function fencedRegions(text: string): PromptRegion[] {
  const regions: PromptRegion[] = []
  let open: { start: number; marker: string; width: number } | undefined
  for (let start = 0; start < text.length;) {
    let end = start
    while (end < text.length && text[end] !== '\r' && text[end] !== '\n') end++
    const next = end + (text[end] === '\r' && text[end + 1] === '\n' ? 2 : end < text.length ? 1 : 0)
    let markerStart = start
    while (markerStart < end && text[markerStart] === ' ') markerStart++
    const marker = text[markerStart]
    if (markerStart - start <= 3 && (marker === '`' || marker === '~')) {
      let markerEnd = markerStart
      while (markerEnd < end && text[markerEnd] === marker) markerEnd++
      const width = markerEnd - markerStart, suffix = text.slice(markerEnd, end)
      if (open) {
        if (marker === open.marker && width >= open.width && /^[ \t]*$/.test(suffix)) {
          regions.push({ kind: 'fenced_example', start: open.start, end: next }); open = undefined
        }
      } else if (width >= 3 && (marker !== '`' || !suffix.includes('`'))) {
        open = { start, marker, width }
      }
    }
    start = next
  }
  if (open) regions.push({ kind: 'fenced_example', start: open.start, end: text.length })
  return regions
}

type Delimiter = { start: number; end: number; key: string; canOpen: boolean; canClose: boolean; next?: number | undefined }
const wordCharacter = (value: string | undefined): boolean => value !== undefined && /[\p{L}\p{N}_$]/u.test(value)

function inlineRegions(text: string, start: number, end: number): PromptRegion[] {
  const delimiters: Delimiter[] = []
  let slashes = 0
  for (let index = start; index < end;) {
    const char = text[index]!, escaped = slashes % 2 === 1
    if (char === '`') {
      let last = index + 1
      while (last < end && text[last] === '`') last++
      // Escapes affect an opener in prose. Inside code, every backslash is literal.
      delimiters.push({ start: index, end: last, key: `tick:${last - index}`, canOpen: !escaped, canClose: true })
      index = last; slashes = 0; continue
    }
    if ((char === '"' || char === "'") && !escaped) {
      delimiters.push({ start: index, end: index + 1, key: char,
        canOpen: char === '"' || !wordCharacter(text[index - 1]),
        canClose: char === '"' || !wordCharacter(text[index + 1]) })
    }
    slashes = char === '\\' ? slashes + 1 : 0
    index++
  }
  // Index the next eligible closer once, rather than searching each suffix.
  // Quotes retain the prior balanced multiline behavior and string escapes.
  const next = new Map<string, number>()
  for (let index = delimiters.length - 1; index >= 0; index--) {
    const delimiter = delimiters[index]!
    delimiter.next = next.get(delimiter.key)
    if (delimiter.canClose) next.set(delimiter.key, index)
  }
  const regions: PromptRegion[] = []
  for (let index = 0; index < delimiters.length; index++) {
    const delimiter = delimiters[index]!
    if (!delimiter.canOpen || delimiter.next === undefined) continue
    const close = delimiters[delimiter.next]!
    regions.push({ kind: delimiter.key.startsWith('tick:') ? 'inline_code' : 'quoted_string', start: delimiter.start, end: close.end })
    index = delimiter.next
  }
  return regions
}

/** Linear scans and delimiter indexing; no nested regions or suffix rescans.
 * Supports 0–3-space top-level CommonMark fences and exact-width code spans.
 * List/blockquote/HTML containers and indented code blocks are not parsed. */
export function scanPromptRegions(text: string): PromptRegion[] {
  const regions: PromptRegion[] = []
  let start = 0
  for (const fence of fencedRegions(text)) {
    for (const region of inlineRegions(text, start, fence.start)) regions.push(region)
    regions.push(fence)
    start = fence.end
  }
  for (const region of inlineRegions(text, start, text.length)) regions.push(region)
  return regions
}

/** Mask ordered nonoverlapping spans without moving offsets or line endings. */
export function maskPromptRegions(text: string, regions: ReadonlyArray<{ start: number; end: number }> = scanPromptRegions(text)): string {
  const parts: string[] = []
  let cursor = 0
  for (const region of regions) {
    parts.push(text.slice(cursor, region.start), text.slice(region.start, region.end).replace(/[^\r\n]/g, ' '))
    cursor = region.end
  }
  parts.push(text.slice(cursor))
  return parts.join('')
}

export function isPromptDataOffset(regions: readonly PromptRegion[], offset: number): boolean {
  let low = 0, high = regions.length
  while (low < high) {
    const middle = (low + high) >>> 1, region = regions[middle]!
    if (offset < region.start) high = middle
    else if (offset >= region.end) low = middle + 1
    else return true
  }
  return false
}
