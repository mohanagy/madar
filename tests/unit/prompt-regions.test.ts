import { describe, expect, it } from 'vitest'
import { isPromptDataOffset, maskPromptRegions, scanPromptRegions } from '../../src/shared/prompt-regions.js'

describe('prompt data regions', () => {
  it('distinguishes same-line code from fences and respects fence kind, width and CRLF', () => {
    const text = '```inline code```\nExclude auth.ts.\r\n  ````js\r\nExclude hidden.ts.\r\n```\r\n~~~~\r\n ```` \t\r\nExplain run().'
    const regions = scanPromptRegions(text)
    expect(regions.map(region => region.kind)).toEqual(['inline_code', 'fenced_example'])
    expect(maskPromptRegions(text, regions)).toContain('Exclude auth.ts.')
    expect(maskPromptRegions(text, regions)).not.toContain('hidden')
    expect(maskPromptRegions(text, regions)).toContain('Explain run().')
    expect(isPromptDataOffset(regions, text.indexOf('hidden'))).toBe(true)
    expect(isPromptDataOffset(regions, regions[1]!.end)).toBe(false)
  })

  it('keeps unclosed fences as data but unmatched quotes and ticks as prose', () => {
    const text = 'Explain run().\n~~~text\nExclude auth.ts.'
    expect(scanPromptRegions(text)).toEqual([{ kind: 'fenced_example', start: 15, end: text.length }])
    for (const text of ['an unmatched `\nExclude auth.ts.', 'an unmatched "\nExclude auth.ts.']) {
      expect(scanPromptRegions(text)).toEqual([])
      expect(maskPromptRegions(text)).toBe(text)
    }
  })

  it('matches exact-width multiline code spans with literal backslashes inside', () => {
    const text = '``a ` caller\nExclude hidden.ts. \\``\nExclude auth.ts.'
    const regions = scanPromptRegions(text)
    expect(regions).toEqual([{ kind: 'inline_code', start: 0, end: text.indexOf('\nExclude auth.ts.') }])
    expect(maskPromptRegions(text)).toContain('Exclude auth.ts.')
    expect(maskPromptRegions('\\`not code`')).toBe('\\`not code`')
  })

  it('preserves UTF-16 offsets and newlines across escaped multiline quotations', () => {
    const text = '😀 worker\'s input isn\'t a request. "first \\"quoted\\"\r\nExclude hidden.ts."\nExclude auth.ts.'
    const regions = scanPromptRegions(text), masked = maskPromptRegions(text, regions)
    expect(regions).toHaveLength(1)
    expect(regions[0]?.start).toBe(text.indexOf('"first'))
    expect(masked.length).toBe(text.length)
    expect([...text.matchAll(/[\r\n]/g)].map(match => match.index)).toEqual([...masked.matchAll(/[\r\n]/g)].map(match => match.index))
    expect(masked).toContain("worker's input isn't a request.")
    expect(masked).toContain('Exclude auth.ts.')
    expect(masked).not.toContain('hidden')
  })

  it('lets the earliest quote or code delimiter own nested delimiters', () => {
    const text = '"a `caller` quote" and `a "quote" example` and \'exclude hidden\''
    expect(scanPromptRegions(text).map(region => region.kind)).toEqual(['quoted_string', 'inline_code', 'quoted_string'])
    expect(maskPromptRegions(text).trim()).toBe('and                     and')
  })
})
