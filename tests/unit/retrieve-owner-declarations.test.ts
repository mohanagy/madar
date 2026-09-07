import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('typescript', async (importOriginal) => {
  const actual = await importOriginal<typeof import('typescript')>()
  return {
    ...actual,
    createSourceFile: vi.fn(actual.createSourceFile),
  }
})

import * as ts from 'typescript'

import { ownerLocalDeclarationEvidence } from '../../src/runtime/query-evidence-dependencies.js'
import { readQueryEvidenceSnippet, type QueryEvidenceSnippet } from '../../src/runtime/retrieve.js'

const QUESTION = 'How does dispatch outcome return a validated result with retry handling?'
const roots: string[] = []

function sourceFixture(
  sourceLines: readonly string[],
  extension = '.ts',
  lineEnding = '\n',
): { sourceFile: string; sourceLocation: string } {
  const fixtureParent = resolve('out', 'test-runtime')
  mkdirSync(fixtureParent, { recursive: true })
  const root = mkdtempSync(join(fixtureParent, 'owner-declaration-'))
  roots.push(root)
  const sourceFile = join(root, `sample${extension}`)
  writeFileSync(sourceFile, sourceLines.join(lineEnding), 'utf8')
  return {
    sourceFile,
    sourceLocation: `L1-L${sourceLines.length}`,
  }
}

function evidenceFor(
  sourceLines: readonly string[],
  options: {
    extension?: string
    label?: string
    lineNumber?: number
    question?: string
    sourceLocation?: string | null
    derived?: boolean
    fileCache?: Map<string, string[] | null>
    lineEnding?: '\n' | '\r\n'
  } = {},
): QueryEvidenceSnippet | null {
  const fixture = sourceFixture(sourceLines, options.extension, options.lineEnding)
  return readQueryEvidenceSnippet(fixture.sourceFile, options.lineNumber ?? 1, {
    question: options.question ?? QUESTION,
    label: options.label ?? 'executeSample',
    sourceLocation: options.sourceLocation === undefined
      ? fixture.sourceLocation
      : options.sourceLocation,
    ...(options.derived === undefined ? {} : { derived: options.derived }),
    ...(options.fileCache ? { fileCache: options.fileCache } : {}),
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
  vi.mocked(ts.createSourceFile).mockClear()
})

describe('owner-local declaration completion', () => {
  it('includes a direct preceding const used by a selected return', () => {
    const evidence = evidenceFor([
      'export function executeSample() {',
      '  const datum = 12.5',
      '  return dispatchOutcome(datum)',
      '}',
    ])

    expect(evidence).toEqual({
      snippet: 'L2:   const datum = 12.5\nL3: return dispatchOutcome(datum)',
      lineNumber: 2,
      scope: 'symbol',
    })
  })

  it('includes a separated declaration without inventing an interval excerpt', () => {
    const evidence = evidenceFor([
      'export function executeSample() {',
      "  const datum = 'ready'",
      '  observeUnrelatedWork()',
      '  return dispatchOutcome(datum)',
      '}',
    ])

    expect(evidence?.snippet).toBe("L2:   const datum = 'ready'\nL4: return dispatchOutcome(datum)")
    expect(evidence?.snippet).not.toContain('observeUnrelatedWork')
  })

  it('includes an acyclic const alias closure once in source order', () => {
    const evidence = evidenceFor([
      'export function executeSample() {',
      '  const origin = 12.5',
      '  const alias = origin',
      '  return dispatchOutcome(alias)',
      '}',
    ])

    expect(evidence?.snippet).toBe([
      'L2:   const origin = 12.5',
      'L3:   const alias = origin',
      'L4: return dispatchOutcome(alias)',
    ].join('\n'))
  })

  it('deduplicates repeated uses and resolves multiple simple declarators by identity', () => {
    const evidence = evidenceFor([
      'export function executeSample() {',
      '  const origin = 12.5, alias = origin',
      '  return dispatchOutcome(alias, alias)',
      '}',
    ])

    expect(evidence?.snippet).toBe([
      'L2:   const origin = 12.5, alias = origin',
      'L3: return dispatchOutcome(alias, alias)',
    ].join('\n'))
    expect(evidence?.snippet.match(/const origin/g)).toHaveLength(1)
  })

  it.each(['.js', '.mjs'])(
    'supports JavaScript function owners in %s files',
    (extension) => {
      const evidence = evidenceFor([
        'export function executeSample() {',
        '  const datum = 12.5',
        '  return dispatchOutcome(datum)',
        '}',
      ], { extension })

      expect(evidence?.snippet).toContain('L2:   const datum = 12.5')
    },
  )

  it.each([
    {
      name: 'function expression',
      source: [
        'export const executeSample = function () {',
        '  const datum = 12.5',
        '  return dispatchOutcome(datum)',
        '}',
      ],
      lineNumber: 1,
      sourceLocation: 'L1-L4',
    },
    {
      name: 'arrow function',
      source: [
        'export const executeSample = () => {',
        '  const datum = 12.5',
        '  return dispatchOutcome(datum)',
        '}',
      ],
      lineNumber: 1,
      sourceLocation: 'L1-L4',
    },
    {
      name: 'line-split arrow variable owner',
      source: [
        'export const executeSample =',
        '  () => {',
        '    const datum = 12.5',
        '    return dispatchOutcome(datum)',
        '  }',
      ],
      lineNumber: 1,
      sourceLocation: 'L1-L5',
    },
    {
      name: 'class method',
      source: [
        'export class SampleProcessor {',
        '  executeSample() {',
        '    const datum = 12.5',
        '    return dispatchOutcome(datum)',
        '  }',
        '}',
      ],
      lineNumber: 2,
      sourceLocation: 'L2-L5',
    },
  ])('supports a complete $name owner', ({ source, lineNumber, sourceLocation }) => {
    const evidence = evidenceFor(source, { lineNumber, sourceLocation })

    expect(evidence?.snippet).toContain('const datum = 12.5')
    expect(evidence?.snippet).toContain('return dispatchOutcome(datum)')
  })

  it('supports TypeScript syntax and gives every multiline initializer line its physical prefix', () => {
    const evidence = evidenceFor([
      'export function executeSample(): unknown {',
      '  const datum: number = buildDatum(',
      '    12.5,',
      '  )',
      '  return dispatchOutcome(datum)',
      '}',
    ])

    expect(evidence?.snippet).toBe([
      'L2:   const datum: number = buildDatum(',
      'L3:     12.5,',
      'L4:   )',
      'L5: return dispatchOutcome(datum)',
    ].join('\n'))
  })

  it('preserves meaningful whitespace in a newly added string-literal declaration', () => {
    const evidence = evidenceFor([
      'export function assemble() {',
      "  const input = 'alpha  beta';",
      '  return { displayedText: input };',
      '}',
    ], { question: 'What is the displayed text?', label: 'assemble' })

    expect(evidence?.snippet).toBe([
      "L2:   const input = 'alpha  beta';",
      'L3: return { displayedText: input };',
    ].join('\n'))
  })

  it.each([
    {
      literalKind: 'escaped string with comment-looking text',
      statement: '  return dispatchOutcome(datum, "alpha  beta \\"// literal")',
      changed: (statement: string) => statement.replace('alpha  beta', 'alpha beta'),
    },
    {
      literalKind: 'template with a tab and escaped delimiter',
      statement: '  return dispatchOutcome(datum, `alpha\tbeta \\` /* literal */`)',
      changed: (statement: string) => statement.replace('\t', ' '),
    },
    {
      literalKind: 'regex with repeated spaces and escaped slashes',
      statement: '  return dispatchOutcome(datum, /alpha  beta\\/\\/tail/)',
      changed: (statement: string) => statement.replace('alpha  beta', 'alpha beta'),
    },
  ])('authenticates exact $literalKind bytes and rejects changed bytes directly', ({ statement, changed }) => {
    const sourceLines = [
      'function assemble() {',
      '  const datum = 12.5',
      statement,
      '}',
    ]
    const input = {
      sourceFilePath: 'sample.ts',
      sourceLines,
      ownerRange: { start: 1, end: 4 },
    }

    expect(ownerLocalDeclarationEvidence({
      ...input,
      representedSource: [{ startLine: 3, endLine: 3, text: statement }],
    })).toEqual([{
      startLine: 2,
      endLine: 2,
      lines: [{ lineNumber: 2, text: '  const datum = 12.5' }],
    }])
    expect(ownerLocalDeclarationEvidence({
      ...input,
      representedSource: [{ startLine: 3, endLine: 3, text: changed(statement) }],
    })).toEqual([])
  })

  it('authenticates complete multiline template boundaries without normalizing literal edges', () => {
    const sourceLines = [
      'function assemble() {',
      '  const datum = 12.5',
      '  return dispatchOutcome(datum, `  alpha  ?',
      ' beta  `)',
      '}',
    ]
    const represented = sourceLines.slice(2, 4).join('\n')
    const input = {
      sourceFilePath: 'sample.ts',
      sourceLines,
      ownerRange: { start: 1, end: 5 },
    }

    expect(ownerLocalDeclarationEvidence({
      ...input,
      representedSource: [{ startLine: 3, endLine: 4, text: represented }],
    })).toHaveLength(1)
    expect(ownerLocalDeclarationEvidence({
      ...input,
      representedSource: [{
        startLine: 3,
        endLine: 4,
        text: represented.replace('  alpha  ?\n beta  ', ' alpha ?\nbeta '),
      }],
    })).toEqual([])
  })

  it('authenticates exact raw CRLF template delimiters and rejects altered delimiters directly', () => {
    const rawSource = [
      'function assemble() {',
      '  const datum = 12.5',
      '  return dispatchOutcome(datum, `  alpha  ?',
      ' beta  `)',
      '}',
    ].join('\r\n')
    const sourceLines = rawSource.split('\n')
    const represented = sourceLines.slice(2, 4).join('\n')
    const input = {
      sourceFilePath: 'sample.ts',
      sourceLines,
      ownerRange: { start: 1, end: 5 },
    }

    expect(ownerLocalDeclarationEvidence({
      ...input,
      representedSource: [{ startLine: 3, endLine: 4, text: represented }],
    })).toEqual([{
      startLine: 2,
      endLine: 2,
      lines: [{ lineNumber: 2, text: '  const datum = 12.5\r' }],
    }])
    expect(ownerLocalDeclarationEvidence({
      ...input,
      representedSource: [{
        startLine: 3,
        endLine: 4,
        text: represented.replace(/\r\n/g, '\n'),
      }],
    })).toEqual([])
  })

  it.each([
    { name: 'CRLF', lineEnding: '\r\n' as const, literalDelimiter: '\r\n' },
    { name: 'LF', lineEnding: '\n' as const, literalDelimiter: '\n' },
  ])('preserves raw multiline template delimiters from a public $name read', ({ lineEnding, literalDelimiter }) => {
    const evidence = evidenceFor([
      'function assemble() {',
      '  const datum = 12.5',
      '  return dispatchOutcome(datum, `  alpha  ?',
      ' beta  `)',
      '}',
    ], { question: 'What is the dispatch outcome?', label: 'assemble', lineEnding })

    expect(evidence).toEqual({
      snippet: [
        'L2:   const datum = 12.5',
        `L3: return dispatchOutcome(datum, \`  alpha  ?${literalDelimiter}L4:  beta  \`)`,
      ].join('\n'),
      lineNumber: 2,
      scope: 'symbol',
    })
  })

  it.each(['\n', '\r\n'] as const)(
    'normalizes %j source layout outside literals while retaining ordinary indentation',
    (lineEnding) => {
      const evidence = evidenceFor([
        'function assemble() {',
        '\tconst datum = 12.5',
        '\treturn datum ?',
        '\t\tdispatchOutcome(datum, `single line`)',
        '\t\t: retryOutcome()',
        '}',
      ], {
        question: 'What are the dispatch outcome and retry outcome?',
        label: 'assemble',
        lineEnding,
      })

      expect(evidence?.snippet).toBe([
        'L2: \tconst datum = 12.5',
        'L3: return datum ? dispatchOutcome(datum, `single line`) : retryOutcome()',
      ].join('\n'))
      expect(evidence?.snippet).not.toContain('\r')
    },
  )

  it('preserves selected string, template, and regex literal bytes while completing their const', () => {
    const statement = '  return dispatchOutcome(datum, "alpha  beta \\"// literal", `left\tright`, /x  y\\/\\/z/)'
    const evidence = evidenceFor([
      'function assemble() {',
      '  const datum = 12.5',
      statement,
      '}',
    ], { question: 'What is the dispatch outcome?', label: 'assemble' })

    expect(evidence).toEqual({
      snippet: [
        'L2:   const datum = 12.5',
        `L3: ${statement.trim()}`,
      ].join('\n'),
      lineNumber: 2,
      scope: 'symbol',
    })
  })

  it('preserves the sealed two-space selected literal instead of authenticating altered display bytes', () => {
    const evidence = evidenceFor([
      'function assemble() {',
      '  const datum = 12.5',
      "  return dispatchOutcome(datum, 'alpha  beta')",
      '}',
    ], { question: 'What is the dispatch outcome?', label: 'assemble' })

    expect(evidence?.snippet).toBe([
      'L2:   const datum = 12.5',
      "L3: return dispatchOutcome(datum, 'alpha  beta')",
    ].join('\n'))
  })

  it('keeps a whitespace-sensitive literal in a complete joined multiline expression', () => {
    const evidence = evidenceFor([
      'function assemble() {',
      '  const datum = 12.5',
      '  return datum ?',
      "    dispatchOutcome(datum, 'alpha  beta')",
      '    : retryOutcome()',
      '}',
    ], { question: 'What are the dispatch outcome and retry outcome?', label: 'assemble' })

    expect(evidence?.snippet).toBe([
      'L2:   const datum = 12.5',
      "L3: return datum ? dispatchOutcome(datum, 'alpha  beta') : retryOutcome()",
    ].join('\n'))
  })

  it('retains multiline template line breaks and line-edge spaces with physical prefixes', () => {
    const evidence = evidenceFor([
      'function assemble() {',
      '  const datum = 12.5',
      '  return dispatchOutcome(datum, `  alpha  ?',
      ' beta  `)',
      '}',
    ], { question: 'What is the dispatch outcome?', label: 'assemble' })

    expect(evidence?.snippet).toBe([
      'L2:   const datum = 12.5',
      'L3: return dispatchOutcome(datum, `  alpha  ?',
      'L4:  beta  `)',
    ].join('\n'))
  })

  it.each(['\n', '\r\n'] as const)(
    'preserves literal content and intended indentation from %j source',
    (lineEnding) => {
      const evidence = evidenceFor([
        'function assemble() {',
        '\tconst datum = 12.5',
        '\treturn dispatchOutcome(datum, `left\tright`, /x  y/)',
        '}',
      ], { question: 'What is the dispatch outcome?', label: 'assemble', lineEnding })

      expect(evidence?.snippet).toBe([
        'L2: \tconst datum = 12.5',
        'L3: return dispatchOutcome(datum, `left\tright`, /x  y/)',
      ].join('\n'))
    },
  )

  it('preserves a literal tab in a string and repeated spaces in a regex', () => {
    const declaration = "  const input = ['alpha\tbeta', /alpha  beta/];"
    const evidence = evidenceFor([
      'export function executeSample() {',
      declaration,
      '  return dispatchOutcome(input)',
      '}',
    ])

    expect(evidence?.snippet).toBe([
      `L2: ${declaration}`,
      'L3: return dispatchOutcome(input)',
    ].join('\n'))
  })

  it('preserves physical multiline template content, including a blank line', () => {
    const evidence = evidenceFor([
      'export function assemble() {',
      '  const input = `  alpha  ',
      '',
      ' beta  `',
      '  return { displayedText: input };',
      '}',
    ], { question: 'What is the displayed text?', label: 'assemble' })

    expect(evidence?.snippet).toBe([
      'L2:   const input = `  alpha  ',
      'L3: ',
      'L4:  beta  `',
      'L5: return { displayedText: input };',
    ].join('\n'))
  })

  it('preserves every physical line of trailing multiline declaration trivia', () => {
    const evidence = evidenceFor([
      'export function executeSample() {',
      '  const datum = 12.5 /* declaration context',
      '    continued */',
      '  return dispatchOutcome(datum)',
      '}',
    ])

    expect(evidence?.snippet).toBe([
      'L2:   const datum = 12.5 /* declaration context',
      'L3:     continued */',
      'L4: return dispatchOutcome(datum)',
    ].join('\n'))
  })

  it('preserves a chain of adjacent multiline declaration trivia atomically', () => {
    const evidence = evidenceFor([
      'export function executeSample() {',
      '  const datum = 12.5 /* first context',
      '    second context */ /* third context',
      '    fourth context */',
      '  return dispatchOutcome(datum)',
      '}',
    ])

    expect(evidence?.snippet).toBe([
      'L2:   const datum = 12.5 /* first context',
      'L3:     second context */ /* third context',
      'L4:     fourth context */',
      'L5: return dispatchOutcome(datum)',
    ].join('\n'))
  })

  it('preserves leading multiline trivia only when it intersects an emitted line', () => {
    const intersecting = evidenceFor([
      'export function executeSample() {',
      '  /* declaration context',
      '     closes here */ const datum = 12.5',
      '  return dispatchOutcome(datum)',
      '}',
    ])
    const standalone = evidenceFor([
      'export function executeSample() {',
      '  /* standalone context',
      '     remains separate */',
      '  const datum = 12.5',
      '  return dispatchOutcome(datum)',
      '}',
    ])

    expect(intersecting?.snippet).toBe([
      'L2:   /* declaration context',
      'L3:      closes here */ const datum = 12.5',
      'L4: return dispatchOutcome(datum)',
    ].join('\n'))
    expect(standalone?.snippet).toBe([
      'L4:   const datum = 12.5',
      'L5: return dispatchOutcome(datum)',
    ].join('\n'))
  })

  it('uses syntax trivia without mistaking comment-like template content for comments', () => {
    const evidence = evidenceFor([
      'export function executeSample() {',
      '  const datum = `/* template text',
      '    // remains literal */` /* declaration context',
      '    continued */',
      '  return dispatchOutcome(datum)',
      '}',
    ])

    expect(evidence?.snippet).toBe([
      'L2:   const datum = `/* template text',
      'L3:     // remains literal */` /* declaration context',
      'L4:     continued */',
      'L5: return dispatchOutcome(datum)',
    ].join('\n'))
  })

  it.each([
    {
      boundary: 'four rendered lines',
      declaration: [
        '  const datum = 12.5 /* declaration context',
        '    continued',
        '    across another physical line',
        '    through the fifth rendered line */',
      ],
    },
    {
      boundary: '220-character physical line',
      declaration: [
        '  const datum = 12.5 /* declaration context',
        `    ${'x'.repeat(215)} */`,
      ],
    },
    {
      boundary: '300-character aggregate',
      declaration: [
        '  const datum = 12.5 /* declaration context',
        `    ${'x'.repeat(205)} */`,
      ],
    },
  ])('declines all declaration lines when closing trivia exceeds the $boundary limit', ({ declaration }) => {
    const evidence = evidenceFor([
      'export function executeSample() {',
      ...declaration,
      "  return dispatchOutcome(datum, 'selected result with enough context to cross the aggregate boundary')",
      '}',
    ])

    expect(evidence?.snippet).toBe(
      "L4: return dispatchOutcome(datum, 'selected result with enough context to cross the aggregate boundary')"
        .replace('L4', `L${declaration.length + 2}`),
    )
  })

  it('attributes a statement whose multiline trailing comment is fully represented', () => {
    const evidence = evidenceFor([
      'export function executeSample() {',
      '  const datum = 12.5',
      '  return dispatchOutcome(datum) /* selected context ?',
      '    complete */',
      '}',
    ])

    expect(evidence?.snippet).toBe([
      'L2:   const datum = 12.5',
      'L3: return dispatchOutcome(datum) /* selected context ? complete */',
    ].join('\n'))
  })

  it('completes an ordinary multiline statement represented by exact physical fragments', () => {
    const evidence = evidenceFor([
      'function assemble() {',
      '  const datum = 12.5',
      '  return { displayedText: datum,',
      '    recordedValue: datum };',
      '}',
    ], {
      label: 'assemble',
      question: 'What are the displayed text and recorded value?',
    })

    expect(evidence).toEqual({
      snippet: [
        'L2:   const datum = 12.5',
        'L3: return { displayedText: datum,',
        'L4: recordedValue: datum };',
      ].join('\n'),
      lineNumber: 2,
      scope: 'symbol',
    })
  })

  it('completes a trailing-comment statement represented by exact physical fragments', () => {
    const evidence = evidenceFor([
      'function assemble() {',
      '  const datum = 12.5',
      '  return { displayedText: datum }; /* detail',
      '    displayed text */',
      '}',
    ], {
      label: 'assemble',
      question: 'What is the displayed text?',
    })

    expect(evidence).toEqual({
      snippet: [
        'L2:   const datum = 12.5',
        'L3: return { displayedText: datum }; /* detail',
        'L4: displayed text */',
      ].join('\n'),
      lineNumber: 2,
      scope: 'symbol',
    })
  })

  it.each([
    {
      coverage: 'split-incomplete',
      representedSource: (sourceLines: readonly string[]) => [
        { startLine: 3, endLine: 3, text: sourceLines[2]! },
        { startLine: 4, endLine: 4, text: sourceLines[3]! },
        { startLine: 5, endLine: 5, text: sourceLines[4]! },
      ],
    },
    {
      coverage: 'gapped',
      representedSource: (sourceLines: readonly string[]) => [
        { startLine: 3, endLine: 3, text: sourceLines[2]! },
        { startLine: 4, endLine: 4, text: sourceLines[3]! },
        { startLine: 6, endLine: 6, text: sourceLines[5]! },
      ],
    },
    {
      coverage: 'clipped',
      representedSource: (sourceLines: readonly string[]) => [
        { startLine: 3, endLine: 3, text: sourceLines[2]! },
        { startLine: 4, endLine: 4, text: sourceLines[3]!.slice(0, -1) },
        { startLine: 5, endLine: 5, text: sourceLines[4]! },
        { startLine: 6, endLine: 6, text: sourceLines[5]! },
      ],
    },
    {
      coverage: 'wrong-byte',
      representedSource: (sourceLines: readonly string[]) => [
        { startLine: 3, endLine: 3, text: sourceLines[2]! },
        { startLine: 4, endLine: 4, text: sourceLines[3]!.replace('datum', 'other') },
        { startLine: 5, endLine: 5, text: sourceLines[4]! },
        { startLine: 6, endLine: 6, text: sourceLines[5]! },
      ],
    },
    {
      coverage: 'foreign-owner',
      representedSource: (sourceLines: readonly string[]) => [
        { startLine: 3, endLine: 3, text: sourceLines[2]! },
        { startLine: 4, endLine: 4, text: sourceLines[3]! },
        { startLine: 5, endLine: 8, text: sourceLines.slice(4, 8).join('\n') },
      ],
    },
    {
      coverage: 'invalid-overlap',
      representedSource: (sourceLines: readonly string[]) => [
        { startLine: 3, endLine: 4, text: sourceLines.slice(2, 4).join('\n') },
        {
          startLine: 4,
          endLine: 6,
          text: sourceLines.slice(3, 6).join('\n').replace('datum', 'other'),
        },
      ],
    },
  ])('rejects $coverage represented coverage for a multiline statement', ({ representedSource }) => {
    const sourceLines = [
      'function assemble() {',
      '  const datum = 12.5',
      '  return {',
      '    displayedText: datum,',
      '    recordedValue: datum,',
      '  }',
      '}',
      'function foreignOwner() { return null }',
    ]

    expect(ownerLocalDeclarationEvidence({
      sourceFilePath: 'sample.ts',
      sourceLines,
      ownerRange: { start: 1, end: 7 },
      representedSource: representedSource(sourceLines),
    })).toEqual([])
  })

  it('does not attribute a statement whose multiline trailing comment is only partially represented', () => {
    const evidence = evidenceFor([
      'export function executeSample() {',
      '  const datum = 12.5',
      '  return dispatchOutcome(datum) /* selected context',
      '    complete */',
      '}',
    ])

    expect(evidence?.snippet).toBe('L3: return dispatchOutcome(datum) /* selected context')
  })

  it.each([
    { representation: 'fully', endLine: 3 },
    { representation: 'partially', endLine: 2 },
  ])('does not re-emit a $representation represented declaration comment', ({ endLine }) => {
    const sourceLines = [
      'export function executeSample() {',
      '  const datum = 12.5 /* declaration context',
      '    complete */',
      '  return dispatchOutcome(datum)',
      '}',
    ]

    expect(ownerLocalDeclarationEvidence({
      sourceFilePath: 'sample.ts',
      sourceLines,
      ownerRange: { start: 1, end: 5 },
      representedSource: [
        {
          startLine: 2,
          endLine,
          text: sourceLines.slice(1, endLine).join('\n'),
        },
        {
          startLine: 4,
          endLine: 4,
          text: sourceLines[3]!,
        },
      ],
    })).toEqual([])
  })

  it('keeps function-owner authority token-bounded before trailing multiline trivia', () => {
    const evidence = evidenceFor([
      'export const executeSample = () => {',
      '  const datum = 12.5',
      '  return dispatchOutcome(datum)',
      '} /* outside owner context',
      '  continued */',
    ], { sourceLocation: 'L1-L4' })

    expect(evidence?.snippet).toBe([
      'L2:   const datum = 12.5',
      'L3: return dispatchOutcome(datum)',
    ].join('\n'))
  })

  it.each([
    {
      name: 'ordinary trailing line comment',
      statement: '  return dispatchOutcome(datum) // selected result',
    },
    {
      name: 'trailing block comment',
      statement: '  return dispatchOutcome(datum) /* selected result */',
    },
    {
      name: 'leading and trailing block-comment trivia',
      statement: '  /* selected result */ return dispatchOutcome(datum) /* trailing context */',
    },
    {
      name: 'comment-like string and template contents with trailing trivia',
      statement: '  return dispatchOutcome(datum, "// literal", `/* template */`) // selected result',
    },
  ])('attributes a fully represented statement with $name', ({ statement }) => {
    const evidence = evidenceFor([
      'export function executeSample() {',
      '  const datum = 12.5',
      statement,
      '}',
    ])

    expect(evidence?.snippet).toBe([
      'L2:   const datum = 12.5',
      `L3: ${statement.trim()}`,
    ].join('\n'))
  })

  it('does not attribute a statement from a truncated partial physical line', () => {
    const statement = `  return dispatchOutcome(datum) // ${'partial'.repeat(40)}`
    const evidence = evidenceFor([
      'export function executeSample() {',
      '  const datum = 12.5',
      statement,
      '}',
    ])

    expect(evidence?.snippet).not.toContain('const datum = 12.5')
    expect(evidence?.snippet).toContain('return dispatchOutcome(datum)')
    expect(evidence?.snippet).toContain('...')
    expect(evidence?.snippet).not.toContain(statement.trim())
  })

  it('uses a selected multiline statement only when its complete text is represented', () => {
    const evidence = evidenceFor([
      'export function executeSample() {',
      "  const datum = 'ready'",
      '  return datum',
      '    ? dispatchOutcome(datum)',
      '    : retryOutcome()',
      '}',
    ])

    expect(evidence?.snippet).toContain("L2:   const datum = 'ready'")
    expect(evidence?.snippet).toContain('return datum ? dispatchOutcome(datum) : retryOutcome()')
  })

  it('resolves a closer block const and never attributes the outer binding', () => {
    const evidence = evidenceFor([
      'export function executeSample() {',
      "  const datum = 'outer'",
      '  {',
      "    const datum = 'inner'",
      '    return dispatchOutcome(datum)',
      '  }',
      '}',
    ])

    expect(evidence?.snippet).toContain("L4:     const datum = 'inner'")
    expect(evidence?.snippet).not.toContain("const datum = 'outer'")
  })

  it('resolves an ancestor-block const when no closer lexical binding exists', () => {
    const evidence = evidenceFor([
      'export function executeSample(flag: boolean) {',
      "  const datum = 'owner'",
      '  if (flag) {',
      '    return dispatchOutcome(datum)',
      '  }',
      '  return retryOutcome()',
      '}',
    ])

    expect(evidence?.snippet).toContain("L2:   const datum = 'owner'")
    expect(evidence?.snippet).toContain('return dispatchOutcome(datum)')
  })

  it('does not cross a parameter binding or a nested-function owner boundary', () => {
    const parameterEvidence = evidenceFor([
      "const datum = 'outside'",
      'export function executeSample(datum: string) {',
      '  return dispatchOutcome(datum)',
      '}',
    ], { lineNumber: 2, sourceLocation: 'L2-L4' })
    const nestedEvidence = evidenceFor([
      'export function executeSample() {',
      "  const datum = 'outer'",
      '  function nestedTask() {',
      '    return dispatchOutcome(datum)',
      '  }',
      '  return finishOuterWork()',
      '}',
    ])

    expect(parameterEvidence?.snippet).not.toContain("const datum = 'outside'")
    expect(nestedEvidence?.snippet).not.toContain("const datum = 'outer'")
  })

  it('does not cross a for-loop binding to an outer const with the same name', () => {
    const evidence = evidenceFor([
      'export function executeSample(values: string[]) {',
      "  const datum = 'outer'",
      '  for (const datum of values) {',
      '    return dispatchOutcome(datum)',
      '  }',
      '  return retryOutcome()',
      '}',
    ])

    expect(evidence?.snippet).not.toContain("const datum = 'outer'")
  })

  it.each([
    { declaration: 'using datum = acquireDatum()' },
    { declaration: 'await using datum = acquireDatum()' },
  ])('does not complete an unsupported $declaration binding', ({ declaration }) => {
    const evidence = evidenceFor([
      'export async function executeSample() {',
      `  ${declaration}`,
      '  return dispatchOutcome(datum)',
      '}',
    ])

    expect(evidence?.snippet).toBe('L3: return dispatchOutcome(datum)')
  })

  it.each([
    {
      name: 'let binding',
      source: ['export function executeSample() {', '  let datum = 12.5', '  return dispatchOutcome(datum)', '}'],
      forbidden: 'let datum',
    },
    {
      name: 'var binding',
      source: ['export function executeSample() {', '  var datum = 12.5', '  return dispatchOutcome(datum)', '}'],
      forbidden: 'var datum',
    },
    {
      name: 'written const binding',
      source: ['export function executeSample() {', '  const datum = 12.5', '  datum = 14', '  return dispatchOutcome(datum)', '}'],
      forbidden: 'const datum',
    },
    {
      name: 'destructured binding',
      source: ['export function executeSample(input: Input) {', '  const { datum } = input', '  return dispatchOutcome(datum)', '}'],
      forbidden: 'const { datum }',
    },
    {
      name: 'declaration after use',
      source: ['export function executeSample() {', '  dispatchOutcome(datum)', '  const datum = 12.5', '  return retryOutcome()', '}'],
      forbidden: 'const datum',
    },
    {
      name: 'foreign lexical block',
      source: ['export function executeSample(flag: boolean) {', '  if (flag) {', '    const datum = 12.5', '  }', '  return dispatchOutcome(datum)', '}'],
      forbidden: 'const datum',
    },
    {
      name: 'cyclic or forward alias closure',
      source: ['export function executeSample() {', '  const first = second', '  const second = first', '  return dispatchOutcome(second)', '}'],
      forbidden: 'const first',
    },
    {
      name: 'initializer containing a nested function',
      source: ['export function executeSample() {', '  const datum = (() => 12.5)()', '  return dispatchOutcome(datum)', '}'],
      forbidden: 'const datum',
    },
  ])('does not guess through a $name', ({ source, forbidden }) => {
    expect(evidenceFor(source)?.snippet).not.toContain(forbidden)
  })

  it('does not use a declaration from a sibling function', () => {
    const evidence = evidenceFor([
      'function siblingTask() {',
      "  const datum = 'sibling'",
      '  return datum',
      '}',
      'export function executeSample() {',
      '  return dispatchOutcome(datum)',
      '}',
    ], { lineNumber: 5, sourceLocation: 'L5-L7' })

    expect(evidence?.snippet).not.toContain("const datum = 'sibling'")
  })

  it('ignores non-value identifier positions but keeps shorthand and computed value uses', () => {
    const propertyOnly = evidenceFor([
      'export function executeSample(service: Service) {',
      "  const datum = 'not-a-value-use'",
      '  return dispatchOutcome({ datum: service.datum }, "datum")',
      '}',
    ])
    const typeOnly = evidenceFor([
      'export function executeSample() {',
      '  const DatumType = 12.5',
      '  return dispatchOutcome(createValue<DatumType>())',
      '}',
    ])
    const shorthand = evidenceFor([
      'export function executeSample() {',
      '  const datum = 12.5',
      '  return dispatchOutcome({ datum })',
      '}',
    ])
    const computed = evidenceFor([
      'export function executeSample() {',
      "  const datum = 'key'",
      '  return dispatchOutcome({ [datum]: true })',
      '}',
    ])

    expect(propertyOnly?.snippet).not.toContain("const datum = 'not-a-value-use'")
    expect(typeOnly?.snippet).not.toContain('const DatumType')
    expect(shorthand?.snippet).toContain('L2:   const datum = 12.5')
    expect(computed?.snippet).toContain("L2:   const datum = 'key'")
  })

  it('ignores labels, comments, and string text as dependency uses', () => {
    const evidence = evidenceFor([
      'export function executeSample() {',
      "  const datum = 'not-a-value-use'",
      '  datum: dispatchOutcome(12.5) // datum is only text here',
      '  return retryOutcome("datum")',
      '}',
    ])

    expect(evidence?.snippet).not.toContain("const datum = 'not-a-value-use'")
  })

  it('preserves no-dependency and unsupported-language output byte for byte', () => {
    const expected = {
      snippet: 'L2: return dispatchOutcome(12.5)',
      lineNumber: 2,
      scope: 'symbol' as const,
    }
    const source = [
      'export function executeSample() {',
      '  return dispatchOutcome(12.5)',
      '}',
    ]

    expect(evidenceFor(source)).toEqual(expected)
    expect(evidenceFor(source, { extension: '.py' })).toEqual(expected)
  })

  it.each([
    { name: 'missing range', sourceLocation: null, derived: false, expected: 'return' },
    { name: 'malformed range', sourceLocation: 'not-a-range', derived: false, expected: 'return' },
    { name: 'clamped range', sourceLocation: 'L1-L99', derived: false, expected: 'return' },
    {
      name: 'incomplete range',
      sourceLocation: 'L1-L2',
      derived: false,
      expected: {
        snippet: 'L2: const datum = 12.5\nL3: return dispatchOutcome(datum)',
        lineNumber: 2,
        scope: 'source_file' as const,
      },
    },
    {
      name: 'declaration-only range',
      sourceLocation: 'L1',
      derived: false,
      expected: {
        snippet: 'L1: export function executeSample() {\nL3: return dispatchOutcome(datum)',
        lineNumber: 1,
        scope: 'source_file' as const,
      },
    },
    { name: 'derived range', sourceLocation: 'L1-L4', derived: true, expected: 'return' },
  ])('preserves the baseline for a $name', ({ sourceLocation, derived, expected }) => {
    const evidence = evidenceFor([
      'export function executeSample() {',
      '  const datum = 12.5',
      '  return dispatchOutcome(datum)',
      '}',
    ], { sourceLocation, derived })

    if (expected === 'return') {
      expect(evidence).toEqual({
        snippet: 'L3: return dispatchOutcome(datum)',
        lineNumber: 3,
        scope: 'symbol',
      })
    } else {
      expect(evidence).toEqual(expected)
    }
  })

  it('preserves an ambiguous same-line function range byte for byte', () => {
    const sourceLine = 'export const executeSample = () => (() => dispatchOutcome(12.5))()'
    expect(evidenceFor([sourceLine], { sourceLocation: 'L1' })).toEqual({
      snippet: `L1: ${sourceLine}`,
      lineNumber: 1,
      scope: 'symbol',
    })
  })

  it('contains parser failure and preserves malformed-source output', () => {
    const evidence = evidenceFor([
      'export function executeSample() {',
      '  const datum = 12.5',
      '  return dispatchOutcome(datum)',
    ])

    expect(evidence).toEqual({
      snippet: 'L3: return dispatchOutcome(datum)',
      lineNumber: 3,
      scope: 'symbol',
    })
  })

  it('does not infer dependencies from a synthesized noncontiguous fragment', () => {
    const evidence = evidenceFor([
      'export function executeSample() {',
      "  const datum = 'hidden'",
      '  dispatchOutcome({',
      "    eventType: 'ready',",
      '    hiddenPayload: datum,',
      '  })',
      '}',
    ], { question: 'How does dispatch outcome use the ready event type?' })

    expect(evidence?.snippet).toContain("eventType: 'ready'")
    expect(evidence?.snippet).not.toContain("const datum = 'hidden'")
  })

  it('does not mistake duplicate string text for a represented statement truncated later', () => {
    const statementText = 'return dispatchOutcome(datum)'
    const evidence = evidenceFor([
      `export const executeSample = function (label = "${statementText}${'x'.repeat(220)}") {`,
      "  const datum = 'hidden'",
      `  ${statementText}`,
      '}',
    ])

    expect(evidence?.snippet).toContain(statementText)
    expect(evidence?.snippet).not.toContain('L3:')
    expect(evidence?.snippet).not.toContain("const datum = 'hidden'")
  })

  it('completes only protected owner evidence during source-file supplementation', () => {
    const evidence = evidenceFor([
      'export function executeSample() {',
      "  const datum = 'owner'",
      '  return computeWidget(datum)',
      '}',
      '',
      'async function workflowTask() {',
      "  const remote = 'foreign'",
      '  return retryDelivery(await dispatchRecord(validateRequest(remote)))',
      '}',
    ], {
      sourceLocation: 'L1-L4',
      question: 'How does compute widget validate and dispatch a record with retry delivery?',
    })

    expect(evidence?.scope).toBe('source_file')
    expect(evidence?.snippet).toContain("L2:   const datum = 'owner'")
    expect(evidence?.snippet).toContain('return computeWidget(datum)')
    expect(evidence?.snippet).not.toContain("const remote = 'foreign'")
  })
})

describe('owner-local binding identity correction', () => {
  it('resolves a function-declaration body const before the function name', () => {
    const evidence = evidenceFor([
      'export function assemble() {',
      '  const assemble = 12.5',
      '  return { displayedText: assemble }',
      '}',
    ], { question: 'What is the displayed text?', label: 'assemble' })

    expect(evidence?.snippet).toBe([
      'L2:   const assemble = 12.5',
      'L3: return { displayedText: assemble }',
    ].join('\n'))
  })

  it('resolves a named-function-expression body const before the function name', () => {
    const evidence = evidenceFor([
      'export const assemble = function assemble() {',
      '  const assemble = 12.5',
      '  return { displayedText: assemble }',
      '}',
    ], { question: 'What is the displayed text?', label: 'assemble' })

    expect(evidence?.snippet).toBe([
      'L2:   const assemble = 12.5',
      'L3: return { displayedText: assemble }',
    ].join('\n'))
  })

  it('does not let a nested named-owner shadow write poison the body const', () => {
    const evidence = evidenceFor([
      'export function assemble() {',
      '  const assemble = 12.5',
      '  const changeNested = function assemble() { assemble = 99 }',
      '  return { displayedText: assemble }',
      '}',
    ], { question: 'What is the displayed text?', label: 'assemble' })

    expect(evidence?.snippet).toBe([
      'L2:   const assemble = 12.5',
      'L4: return { displayedText: assemble }',
    ].join('\n'))
  })

  it('rejects the body const across a genuine nested-owner captured write', () => {
    const evidence = evidenceFor([
      'export function assemble() {',
      '  const assemble = 12.5',
      '  const changeNested = () => { assemble = 99 }',
      '  return { displayedText: assemble }',
      '}',
    ], { question: 'What is the displayed text?', label: 'assemble' })

    expect(evidence?.snippet).toBe('L4: return { displayedText: assemble }')
  })

  it.each([
    {
      barrier: 'function-scoped var',
      source: [
        'export function executeSample() {',
        "  var datum = 'function binding'",
        '  {',
        "    const datum = 'block binding'",
        '    return dispatchOutcome(datum)',
        '  }',
        '}',
      ],
      forbidden: 'var datum',
    },
    {
      barrier: 'owner parameter',
      source: [
        'export function executeSample(datum: string) {',
        '  {',
        "    const datum = 'block binding'",
        '    return dispatchOutcome(datum)',
        '  }',
        '}',
      ],
      forbidden: 'executeSample(datum',
    },
  ])('resolves a closer block const before a $barrier barrier', ({ source, forbidden }) => {
    const evidence = evidenceFor(source)

    expect(evidence?.snippet).toContain("const datum = 'block binding'")
    expect(evidence?.snippet).not.toContain(forbidden)
  })

  it.each([
    {
      location: 'sibling block write',
      source: [
        'export function executeSample() {',
        "  const datum = 'owner binding'",
        "  { let datum = 'sibling binding'; datum = 'changed' }",
        '  return dispatchOutcome(datum)',
        '}',
      ],
    },
    {
      location: 'nested-owner write',
      source: [
        'export function executeSample() {',
        "  const datum = 'owner binding'",
        "  function changeNested() { let datum = 'nested binding'; datum = 'changed' }",
        '  return dispatchOutcome(datum)',
        '}',
      ],
    },
  ])('does not let a $location to a different binding poison the owner const', ({ source }) => {
    const evidence = evidenceFor(source)

    expect(evidence?.snippet).toContain("L2:   const datum = 'owner binding'")
    expect(evidence?.snippet).toContain('return dispatchOutcome(datum)')
  })

  it('resolves a transitive const chain through sibling and nested-owner shadow writes', () => {
    const evidence = evidenceFor([
      'export function executeSample() {',
      '  const origin = 12.5',
      '  const alias = origin',
      '  { let origin = 99; origin = 100 }',
      "  function changeNested() { let alias = 'nested'; alias = 'changed' }",
      '  return dispatchOutcome(alias)',
      '}',
    ])

    expect(evidence?.snippet).toBe([
      'L2:   const origin = 12.5',
      'L3:   const alias = origin',
      'L6: return dispatchOutcome(alias)',
    ].join('\n'))
  })

  it.each([
    {
      location: 'sibling block',
      source: [
        'export function executeSample() {',
        "  const datum = 'owner binding'",
        "  { datum = 'changed' }",
        '  return dispatchOutcome(datum)',
        '}',
      ],
    },
    {
      location: 'nested owner',
      source: [
        'export function executeSample() {',
        "  const datum = 'owner binding'",
        "  function changeNested() { datum = 'changed' }",
        '  return dispatchOutcome(datum)',
        '}',
      ],
    },
  ])('rejects the owner const when a $location writes that same binding', ({ source }) => {
    const evidence = evidenceFor(source)

    expect(evidence?.snippet).not.toContain("const datum = 'owner binding'")
    expect(evidence?.snippet).toContain('return dispatchOutcome(datum)')
  })

  it.each([
    {
      barrier: 'for-loop binding',
      source: [
        'export function executeSample(values: string[]) {',
        "  const datum = 'owner binding'",
        '  for (const datum of values) {',
        '    return dispatchOutcome(datum)',
        '  }',
        '  return retryOutcome()',
        '}',
      ],
    },
    {
      barrier: 'catch binding',
      source: [
        'export function executeSample() {',
        "  const datum = 'owner binding'",
        '  try {',
        "    throw new Error('failed')",
        '  } catch (datum) {',
        '    return dispatchOutcome(datum)',
        '  }',
        '}',
      ],
    },
  ])('keeps a nearer $barrier as a barrier to the outer const', ({ source }) => {
    const evidence = evidenceFor(source)

    expect(evidence?.snippet).not.toContain("const datum = 'owner binding'")
    expect(evidence?.snippet).toContain('return dispatchOutcome(datum)')
  })
})

describe('owner declaration completion budgets and atomic preservation', () => {
  it('admits faithful literal whitespace when the completed snippet exactly fills the cap', () => {
    const literal = `${'value  '.repeat(22)}end`
    const returnSource = `  return dispatchOutcome(datum, '${literal}')`
    const renderedReturn = `L3: ${returnSource.trim()}`
    const declarationShell = "L2:   const datum = ''"
    const fillLength = 300 - renderedReturn.length - declarationShell.length - 1
    const declarationSource = `  const datum = '${'d'.repeat(fillLength)}'`
    const renderedDeclaration = `L2: ${declarationSource}`

    const evidence = evidenceFor([
      'export function executeSample() {',
      declarationSource,
      returnSource,
      '}',
    ])

    expect(fillLength).toBeGreaterThan(0)
    expect(returnSource.length).toBeLessThanOrEqual(220)
    expect(evidence?.snippet).toBe(`${renderedDeclaration}\n${renderedReturn}`)
    expect(evidence?.snippet).toHaveLength(300)
  })

  it('counts literal whitespace for overflow without clipping selected source or adding its declaration', () => {
    const literal = `${'value  '.repeat(24)}end`
    const returnSource = `  return dispatchOutcome(datum, '${literal}')`
    const declarationSource = `  const datum = '${'d'.repeat(105)}'`
    const baseline = `L3: ${returnSource.trim()}`
    expect(returnSource.length).toBeLessThanOrEqual(220)
    expect(`L2: ${declarationSource}\n${baseline}`.length).toBeGreaterThan(300)

    const evidence = evidenceFor([
      'export function executeSample() {',
      declarationSource,
      returnSource,
      '}',
    ])

    expect(evidence?.snippet).toBe(baseline)
    expect(evidence?.snippet).not.toContain('const datum')
    expect(evidence?.snippet).not.toContain('...')
  })

  it('admits a declaration closure that exactly fills the 300-character cap', () => {
    const returnSource = `  return dispatchOutcome(datum, '${'r'.repeat(48)}')`
    const renderedReturn = `L3: ${returnSource.trim()}`
    const declarationShell = "L2:   const datum = ''"
    const fillLength = 300 - renderedReturn.length - declarationShell.length - 1
    const declarationSource = `  const datum = '${'d'.repeat(fillLength)}'`
    const renderedDeclaration = `L2: ${declarationSource}`

    const evidence = evidenceFor([
      'export function executeSample() {',
      declarationSource,
      returnSource,
      '}',
    ])

    expect(renderedDeclaration.slice(4).length).toBeLessThanOrEqual(220)
    expect(evidence?.snippet).toBe(`${renderedDeclaration}\n${renderedReturn}`)
    expect(evidence?.snippet).toHaveLength(300)
  })

  it('rejects a declaration whose physical fragment exceeds 220 characters', () => {
    const declaration = `  const datum = '${'d'.repeat(205)}'`
    const baseline = 'L3: return dispatchOutcome(datum)'
    expect(declaration).toHaveLength(223)

    const evidence = evidenceFor([
      'export function executeSample() {',
      declaration,
      '  return dispatchOutcome(datum)',
      '}',
    ])

    expect(evidence?.snippet).toBe(baseline)
  })

  it('rejects an atomic closure that would exceed four rendered fragments', () => {
    const evidence = evidenceFor([
      'export function executeSample() {',
      '  const first = 1',
      '  const second = first',
      '  const third = second',
      '  const fourth = third',
      '  return dispatchOutcome(fourth)',
      '}',
    ])

    expect(evidence?.snippet).toBe('L6: return dispatchOutcome(fourth)')
  })

  it('rejects total overflow without removing or truncating prior selected evidence', () => {
    const declaration = `  const datum = '${'d'.repeat(190)}'`
    const source = [
      'export function executeSample() {',
      declaration,
      '  await dispatchOutcome(datum)',
      '  await retryOutcome(datum)',
      '  return validateResult(datum)',
      '}',
    ]
    const baseline = [
      'L3: await dispatchOutcome(datum)',
      'L4: await retryOutcome(datum)',
      'L5: return validateResult(datum)',
    ].join('\n')

    const evidence = evidenceFor(source)

    expect(evidence?.snippet).toBe(baseline)
    expect(evidence?.snippet).toContain('L5: return validateResult(datum)')
  })
})

describe('owner declaration parse snapshot cache', () => {
  it('preserves raw CRLF literal provenance across a warm public cache hit', () => {
    const source = [
      'function assemble() {',
      '  const datum = 12.5',
      '  return dispatchOutcome(datum, `  alpha  ?',
      ' beta  `)',
      '}',
    ]
    const { sourceFile, sourceLocation } = sourceFixture(source, '.ts', '\r\n')
    const fileCache = new Map<string, string[] | null>()
    const read = () => readQueryEvidenceSnippet(sourceFile, 1, {
      question: 'What is the dispatch outcome?',
      label: 'assemble',
      sourceLocation,
      fileCache,
    })

    const cold = read()
    const warm = read()

    expect(cold?.snippet).toContain('`  alpha  ?\r\nL4:  beta  `')
    expect(warm).toEqual(cold)
    expect(fileCache.get(sourceFile)).toEqual(source)
    expect(ts.createSourceFile).toHaveBeenCalledTimes(1)
  })

  it('does not invent CRLF bytes for a caller-supplied normalized cache', () => {
    const source = [
      'function assemble() {',
      '  const datum = 12.5',
      '  return dispatchOutcome(datum, `  alpha  ?',
      ' beta  `)',
      '}',
    ]
    const { sourceFile, sourceLocation } = sourceFixture(source, '.ts', '\r\n')
    const fileCache = new Map<string, string[] | null>([[sourceFile, [...source]]])
    const evidence = readQueryEvidenceSnippet(sourceFile, 1, {
      question: 'What is the dispatch outcome?',
      label: 'assemble',
      sourceLocation,
      fileCache,
    })

    expect(evidence?.snippet).toContain('`  alpha  ?\nL4:  beta  `')
    expect(evidence?.snippet).not.toContain('\r')
  })

  it('does not reuse raw provenance after the cache array content or path changes', () => {
    const source = [
      'function assemble() {',
      '  const datum = 12.5',
      '  return dispatchOutcome(datum, `  alpha  ?',
      ' beta  `)',
      '}',
    ]
    const firstFixture = sourceFixture(source, '.ts', '\r\n')
    const secondFixture = sourceFixture(source, '.mts', '\r\n')
    const fileCache = new Map<string, string[] | null>()
    const options = (sourceLocation: string) => ({
      question: 'What is the dispatch outcome?',
      label: 'assemble',
      sourceLocation,
      fileCache,
    })

    const cold = readQueryEvidenceSnippet(
      firstFixture.sourceFile,
      1,
      options(firstFixture.sourceLocation),
    )
    const cachedLines = fileCache.get(firstFixture.sourceFile)!
    fileCache.set(secondFixture.sourceFile, cachedLines)
    const changedPath = readQueryEvidenceSnippet(
      secondFixture.sourceFile,
      1,
      options(secondFixture.sourceLocation),
    )
    cachedLines[2] = '  return dispatchOutcome(datum, `  changed  ?'
    const changedContent = readQueryEvidenceSnippet(
      firstFixture.sourceFile,
      1,
      options(firstFixture.sourceLocation),
    )

    expect(cold?.snippet).toContain('`  alpha  ?\r\nL4:  beta  `')
    expect(changedPath?.snippet).toContain('`  alpha  ?\nL4:  beta  `')
    expect(changedPath?.snippet).not.toContain('\r')
    expect(changedContent?.snippet).toContain('`  changed  ?\nL4:  beta  `')
    expect(changedContent?.snippet).not.toContain('\r')
  })

  it('invalidates changed content or paths even when the source-line array identity is reused', () => {
    const sourceLines = [
      'export function executeSample() {',
      "  const datum = 'first'",
      '  return dispatchOutcome(datum)',
      '}',
    ]
    const evidence = (sourceFilePath: string) => ownerLocalDeclarationEvidence({
      sourceFilePath,
      sourceLines,
      ownerRange: { start: 1, end: 4 },
      representedSource: [{ startLine: 3, endLine: 3, text: sourceLines[2]! }],
    })

    expect(evidence('sample.ts')[0]?.lines[0]?.text).toContain("'first'")
    sourceLines[1] = "  const datum = 'second'"
    expect(evidence('sample.ts')[0]?.lines[0]?.text).toContain("'second'")
    expect(evidence('sample.mts')[0]?.lines[0]?.text).toContain("'second'")
    expect(ts.createSourceFile).toHaveBeenCalledTimes(3)
  })

  it('does not reuse a parsed source after content changes at the same path', () => {
    const firstSource = [
      'export function executeSample() {',
      "  const datum = 'first'",
      '  return dispatchOutcome(datum)',
      '}',
    ]
    const secondSource = [
      'export function executeSample() {',
      "  const datum = 'second'",
      '  return dispatchOutcome(datum)',
      '}',
    ]
    const { sourceFile, sourceLocation } = sourceFixture(firstSource)
    const fileCache = new Map<string, string[] | null>()
    const options = {
      question: QUESTION,
      label: 'executeSample',
      sourceLocation,
      fileCache,
    }

    const first = readQueryEvidenceSnippet(sourceFile, 1, options)
    writeFileSync(sourceFile, secondSource.join('\n'), 'utf8')
    fileCache.set(sourceFile, [...secondSource])
    const second = readQueryEvidenceSnippet(sourceFile, 1, options)

    expect(first?.snippet).toContain("const datum = 'first'")
    expect(second?.snippet).toContain("const datum = 'second'")
    expect(second?.snippet).not.toContain("const datum = 'first'")
  })

  it('parses an unchanged cached source snapshot at most once', () => {
    const source = [
      'export function executeSample() {',
      '  const datum = 12.5',
      '  return dispatchOutcome(datum)',
      '}',
    ]
    const { sourceFile, sourceLocation } = sourceFixture(source)
    const fileCache = new Map<string, string[] | null>()
    const options = {
      question: QUESTION,
      label: 'executeSample',
      sourceLocation,
      fileCache,
    }

    readQueryEvidenceSnippet(sourceFile, 1, options)
    readQueryEvidenceSnippet(sourceFile, 1, options)

    expect(ts.createSourceFile).toHaveBeenCalledTimes(1)
  })
})
