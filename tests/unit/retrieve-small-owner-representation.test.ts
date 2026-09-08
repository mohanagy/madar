import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { generateGraph } from '../../src/infrastructure/generate.js'
import {
  compactRetrieveResultForStdio,
  retrieveContext,
  withRetrieveSnippetBudget,
  type RetrieveOptions,
  type RetrieveResult,
} from '../../src/runtime/retrieve.js'
import {
  completeSmallOwnerSourceEvidence,
  retainQueryEvidenceSourceSnapshot,
} from '../../src/runtime/query-evidence-dependencies.js'
import { estimateQueryTokens, loadGraph } from '../../src/runtime/serve.js'
import { handleStdioRequest } from '../../src/runtime/stdio-server.js'

const PRE_SOURCE = `export function parseDecimalRatio(input) {
  if (typeof input !== 'string') return null;
  const normalized = input.trim();
  if (normalized !== '' && !/^(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}
`

const POST_SOURCE = PRE_SOURCE.replace(
  "  if (normalized !== ''",
  "  if (normalized === '') return null;\n  if (normalized !== ''",
)

const PACKAGE_SOURCE = '{"type":"module"}\n'

const PUBLIC_CALLS = [
  {
    itemId: 'item_2',
    state: 'pre',
    question: 'Return the current source of parseDecimalRatio in parser.js, especially lines 1-7 and the defect span at lines 3-5. Do not include unrelated files.',
    budget: 1_200,
    snippetBudget: 800,
    topNWithSnippet: 5,
  },
  {
    itemId: 'item_4',
    state: 'pre',
    question: 'Show the complete implementation text of export function parseDecimalRatio(input) from parser.js, including every source line from the opening brace through the closing brace. Exact source is required.',
    budget: 3_000,
    snippetBudget: 2_400,
    topNWithSnippet: 12,
    retrievalLevel: 5,
    retrievalStrategy: 'slice-v1',
  },
  {
    itemId: 'item_5',
    state: 'pre',
    question: 'In parser.js parseDecimalRatio, return the exact source statements that reject non-string input, trim input, validate the ASCII decimal regular-expression grammar, and convert normalized input with Number(). Include source snippets verbatim.',
    budget: 3_000,
    snippetBudget: 2_400,
    topNWithSnippet: 20,
    retrievalLevel: 5,
  },
  {
    itemId: 'item_6',
    state: 'pre',
    question: 'What is the exact regular-expression validation source line in parser.js immediately after `const normalized = input.trim();` and before `const value = Number(normalized);`? Return that parser.js line verbatim.',
    budget: 1_600,
    snippetBudget: 1_200,
    topNWithSnippet: 12,
    retrievalLevel: 5,
  },
  {
    itemId: 'item_12',
    state: 'post',
    question: "Return the current post-edit source of parseDecimalRatio in parser.js. Specifically include the explicit trimmed-empty guard `if (normalized === '') return null;` and surrounding lines so its presence can be verified.",
    budget: 2_400,
    snippetBudget: 1_800,
    topNWithSnippet: 12,
    retrievalLevel: 5,
  },
  {
    itemId: 'item_14',
    state: 'post',
    question: "Return parser.js line 4 verbatim from the current source. It is the trimmed-empty conditional inside parseDecimalRatio between `const normalized = input.trim();` on line 3 and the regex validation on line 5.",
    budget: 2_400,
    snippetBudget: 1_800,
    topNWithSnippet: 20,
    retrievalLevel: 5,
  },
] as const

type PublicState = (typeof PUBLIC_CALLS)[number]['state']

interface PublicFixture {
  graph: ReturnType<typeof loadGraph>
  graphPath: string
  fullSnippet: string
}

interface PublicResult {
  itemId: string
  state: PublicState
  raw: RetrieveResult
  compact: ReturnType<typeof compactRetrieveResultForStdio>
}

const roots: string[] = []
const fixtures = new Map<PublicState, PublicFixture>()

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function numberedOwner(source: string): string {
  return source.trimEnd().split('\n').map((line, index) => `L${index + 1}: ${line}`).join('\n')
}

function ownerSnippet(result: {
  matched_nodes: ReadonlyArray<{ label: string; snippet: string | null }>
}): string | null | undefined {
  const matches = result.matched_nodes.filter((node) => node.label === 'parseDecimalRatio()')
  expect(matches, 'generated parseDecimalRatio owner must be uniquely retrieved').toHaveLength(1)
  return matches[0]?.snippet
}

function matchedByLabel(
  result: { matched_nodes: ReadonlyArray<{
    label: string
    snippet: string | null
    snippet_truncated?: boolean
  }> },
  label: string,
) {
  const matches = result.matched_nodes.filter((node) => node.label === label)
  expect(matches, `expected one retrieved ${label}`).toHaveLength(1)
  return matches[0]!
}

function numberedLines(source: string, startLine = 1): string {
  const lineEnding = source.includes('\r\n') ? '\r\n' : '\n'
  const withoutTerminalDelimiter = source.endsWith(lineEnding)
    ? source.slice(0, -lineEnding.length)
    : source
  return withoutTerminalDelimiter
    .split(lineEnding)
    .map((line, offset) => `L${startLine + offset}: ${line}`)
    .join(lineEnding)
}

function generatedFixture(source: string, relativePath = 'src/sample.ts') {
  const root = mkdtempSync(join(tmpdir(), 'small-owner-generic-'))
  roots.push(root)
  const directory = join(root, 'src')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(root, relativePath), source, 'utf8')
  writeFileSync(join(root, 'package.json'), PACKAGE_SOURCE, 'utf8')
  const generated = generateGraph(root, { noHtml: true })
  return {
    root,
    sourceFile: join(root, relativePath),
    graph: loadGraph(generated.graphPath),
  }
}

function completeFromText(input: {
  source: string
  ownerRange: { start: number; end: number }
  label: string
  nodeKind?: string
  externalCall?: boolean
  sourceFilePath?: string
}) {
  const sourceFilePath = input.sourceFilePath ?? 'sample.ts'
  const sourceLines = input.source.split(/\r?\n/)
  retainQueryEvidenceSourceSnapshot({ sourceFilePath, sourceLines, sourceText: input.source })
  return completeSmallOwnerSourceEvidence({
    sourceFilePath,
    sourceLines,
    ownerRange: input.ownerRange,
    label: input.label,
    ...(input.nodeKind ? { nodeKind: input.nodeKind } : {}),
    ...(input.externalCall !== undefined ? { externalCall: input.externalCall } : {}),
  })
}

function createPublicFixture(state: PublicState, source: string, expectedHash: string): PublicFixture {
  expect(Buffer.byteLength(source)).toBe(state === 'pre' ? 334 : 372)
  expect(sha256(source)).toBe(expectedHash)
  expect(Buffer.byteLength(PACKAGE_SOURCE)).toBe(18)
  expect(sha256(PACKAGE_SOURCE)).toBe('1239d4d885dcad42201a27ed9324f8f0f760b78700d8db9ced39a511cffe7eae')

  const root = mkdtempSync(join(tmpdir(), `small-owner-public-${state}-`))
  roots.push(root)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'parser.js'), source, 'utf8')
  writeFileSync(join(root, 'package.json'), PACKAGE_SOURCE, 'utf8')
  const generated = generateGraph(root, { noHtml: true })
  return {
    graph: loadGraph(generated.graphPath),
    graphPath: generated.graphPath,
    fullSnippet: numberedOwner(source),
  }
}

beforeAll(() => {
  fixtures.set('pre', createPublicFixture(
    'pre',
    PRE_SOURCE,
    'e7c2028b74b2d7c1c094af7fa284c68acb76447202196de64b8255857215a676',
  ))
  fixtures.set('post', createPublicFixture(
    'post',
    POST_SOURCE,
    '6d003964273fecef9bf750995bea5a59c7cc8d29235834aa9e4a64d4e6418020',
  ))
})

afterAll(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('complete small-owner source representation', () => {
  it('returns every physical owner line for all six frozen public parser requests', () => {
    const results: PublicResult[] = PUBLIC_CALLS.map((call) => {
      const fixture = fixtures.get(call.state)!
      const options: RetrieveOptions = {
        question: call.question,
        budget: call.budget,
        ...('retrievalLevel' in call ? { retrievalLevel: call.retrievalLevel } : {}),
        ...('retrievalStrategy' in call ? { retrievalStrategy: call.retrievalStrategy } : {}),
      }
      const retrieved = retrieveContext(fixture.graph, options)
      const snippetOptions = {
        snippetBudget: call.snippetBudget,
        topNWithSnippet: call.topNWithSnippet,
      }
      return {
        itemId: call.itemId,
        state: call.state,
        raw: withRetrieveSnippetBudget(retrieved, snippetOptions),
        compact: compactRetrieveResultForStdio(retrieved, snippetOptions),
      }
    })

    for (const result of results) {
      const expected = fixtures.get(result.state)!.fullSnippet
      expect.soft(ownerSnippet(result.raw), `${result.itemId} raw complete owner`).toBe(expected)
      expect.soft(ownerSnippet(result.compact), `${result.itemId} compact complete owner`).toBe(expected)
    }
  }, 120_000)

  it('carries the complete owner through the actual verbose stdio retrieve handler', async () => {
    const fixture = fixtures.get('post')!
    const call = PUBLIC_CALLS[4]
    const response = await Promise.resolve(handleStdioRequest(fixture.graphPath, {
      id: 12,
      method: 'tools/call',
      params: {
        name: 'retrieve',
        arguments: {
          question: call.question,
          budget: call.budget,
          snippet_budget: call.snippetBudget,
          top_n_with_snippet: call.topNWithSnippet,
          retrieval_level: call.retrievalLevel,
          verbose: true,
        },
      },
    }))
    const text = (response as { result?: { content?: Array<{ text?: string }> } })
      .result?.content?.[0]?.text
    const payload = JSON.parse(text ?? '{}') as RetrieveResult

    expect(ownerSnippet(payload)).toBe(fixture.fullSnippet)
    expect(JSON.stringify(payload)).toContain("L4:   if (normalized === '') return null;")
  }, 120_000)

  it('represents renamed function and method owners from generated graphs', () => {
    const source = [
      'export function renamedFlow(input: string) {',
      '  // retain this decision comment',
      "  if (input === '') return null;",
      '  const normalized = input.trim();',
      '  auditTrail.push(normalized);',
      '  return normalized;',
      '}',
      'export const arrowOwner = (value: number) => {',
      '  if (value < 0) return 0;',
      '  return value + 1;',
      '};',
      'export const expressionOwner = function (value: number) {',
      '  record(value);',
      '  return value * 2;',
      '};',
      'export class RenamedProcessor {',
      '  calculate(value: number) {',
      '    if (!value) return 0;',
      '    this.seen = value;',
      '    return value;',
      '  }',
      '}',
    ].join('\n') + '\n'
    const fixture = generatedFixture(source)
    const cases = [
      { label: 'renamedFlow()', start: 1, end: 7 },
      { label: '.calculate()', start: 17, end: 21 },
    ]
    const generatedLabels = fixture.graph.nodeEntries().map(([, attributes]) => attributes.label)

    for (const owner of cases) {
      expect(generatedLabels, `generated labels for ${owner.label}`).toContain(owner.label)
      const result = retrieveContext(fixture.graph, {
        question: `How does ${owner.label} process and return the value? Return its exact complete source implementation in sample.ts`,
        budget: 4_000,
        retrievalLevel: 5,
      })
      const expected = source
        .trimEnd()
        .split('\n')
        .slice(owner.start - 1, owner.end)
        .map((line, offset) => `L${owner.start + offset}: ${line}`)
        .join('\n')
      expect(matchedByLabel(result, owner.label).snippet, owner.label).toBe(expected)
    }
  }, 120_000)

  it.each([
    {
      name: 'arrow binding',
      source: 'export const renamedBinding = (value: number) => {\n  return value + 1;\n};',
      label: 'renamedBinding',
    },
    {
      name: 'function-expression binding',
      source: 'export const renamedBinding = function (value: number) {\n  return value + 1;\n};',
      label: 'renamedBinding()',
    },
  ])('resolves a supported $name by its AST binding identity', ({ source, label }) => {
    expect(completeFromText({
      source,
      ownerRange: { start: 1, end: 3 },
      label,
      nodeKind: 'function',
    })?.snippet).toBe(numberedLines(source))
  })

  it('keeps nested, adjacent, and same-line owners bounded to their own declarations', () => {
    const source = [
      'export function outerOwner(value: number) {',
      '  function nestedOwner() { return value + 1; }',
      '  return nestedOwner();',
      '}',
      'export function adjacentLeft() { return 1; } export function adjacentRight() { return 2; }',
      'export function siblingCall(value: number) { return Math.floor(value); } notifySibling();',
    ].join('\n') + '\n'
    const fixture = generatedFixture(source)

    const expected = new Map([
      ['outerOwner()', numberedLines(source.split('\n').slice(0, 4).join('\n'))],
      ['nestedOwner()', 'L2:   function nestedOwner() { return value + 1; }'],
      ['adjacentLeft()', 'L5: export function adjacentLeft() { return 1; }'],
      ['adjacentRight()', 'L5: export function adjacentRight() { return 2; }'],
      ['siblingCall()', 'L6: export function siblingCall(value: number) { return Math.floor(value); }'],
    ])
    for (const [label, snippet] of expected) {
      const result = retrieveContext(fixture.graph, {
        question: `Return exact complete source for ${label}`,
        budget: 4_000,
        retrievalLevel: 5,
      })
      expect(matchedByLabel(result, label).snippet).toBe(snippet)
    }
  }, 120_000)

  it('rejects synthetic, mismatched, foreign, malformed, and unsupported owner authority', () => {
    const source = 'export function trustedOwner(value: number) { return Math.floor(value); }\n'
    const valid = {
      source,
      ownerRange: { start: 1, end: 1 },
      label: 'trustedOwner()',
      nodeKind: 'function',
    }

    expect(completeFromText(valid)?.snippet).toBe(
      'L1: export function trustedOwner(value: number) { return Math.floor(value); }',
    )
    expect(completeFromText({ ...valid, label: 'Math.floor', externalCall: true })).toBeNull()
    expect(completeFromText({ ...valid, label: 'misleadingOwner()' })).toBeNull()
    expect(completeFromText({ ...valid, nodeKind: 'class' })).toBeNull()
    expect(completeFromText({ ...valid, ownerRange: { start: 1, end: 2 } })).toBeNull()
    expect(completeFromText({ ...valid, sourceFilePath: 'sample.go' })).toBeNull()
    expect(completeFromText({
      source: 'export function unfinished(value: number): number;\n',
      ownerRange: { start: 1, end: 1 },
      label: 'unfinished()',
      nodeKind: 'function',
    })).toBeNull()
    expect(completeFromText({
      source: 'export function malformed( {\n',
      ownerRange: { start: 1, end: 1 },
      label: 'malformed()',
      nodeKind: 'function',
    })).toBeNull()
  })

  it('admits exactly 25 physical lines and rejects 26', () => {
    const owner = (lineCount: number) => [
      'export function lineBoundary() {',
      ...Array.from({ length: lineCount - 2 }, (_, index) => `  void ${index};`),
      '}',
    ].join('\n')

    expect(completeFromText({
      source: owner(25),
      ownerRange: { start: 1, end: 25 },
      label: 'lineBoundary()',
      nodeKind: 'function',
    })?.snippet.split('\n')).toHaveLength(25)
    expect(completeFromText({
      source: owner(26),
      ownerRange: { start: 1, end: 26 },
      label: 'lineBoundary()',
      nodeKind: 'function',
    })).toBeNull()
  })

  it('admits exactly 2000 original owner characters and rejects 2001', () => {
    const owner = (characterCount: number) => {
      const prefix = 'export function characterBoundary() {\n  /*'
      const suffix = '*/\n}'
      return `${prefix}${'x'.repeat(characterCount - prefix.length - suffix.length)}${suffix}`
    }
    const exact = owner(2_000)
    const tooLarge = owner(2_001)
    expect(exact).toHaveLength(2_000)
    expect(tooLarge).toHaveLength(2_001)
    expect(completeFromText({
      source: exact,
      ownerRange: { start: 1, end: 3 },
      label: 'characterBoundary()',
      nodeKind: 'function',
    })).not.toBeNull()
    expect(completeFromText({
      source: tooLarge,
      ownerRange: { start: 1, end: 3 },
      label: 'characterBoundary()',
      nodeKind: 'function',
    })).toBeNull()
  })

  it('preserves LF and CRLF bytes through multiline literals, regex, escapes, and interpolation', () => {
    for (const lineEnding of ['\n', '\r\n'] as const) {
      const source = [
        'export function literalOwner(name: string) {',
        '  const escaped = "a\\\\b\\\"c";',
        '  const pattern = /^(?:a\\/b|c\\s+)$/;',
        '  const message = `  hello ${name}',
        '    continued  `;',
        '  return pattern.test(escaped) ? message : null;',
        '}',
      ].join(lineEnding)
      const evidence = completeFromText({
        source,
        ownerRange: { start: 1, end: 7 },
        label: 'literalOwner()',
        nodeKind: 'function',
      })
      expect(evidence?.snippet).toBe(numberedLines(source))
      expect(evidence?.snippet).toContain('const escaped = "a\\\\b\\\"c";')
      expect(evidence?.snippet).toContain('/^(?:a\\/b|c\\s+)$/')
      expect(evidence?.snippet).toContain(`\${name}${lineEnding}L5:     continued  \`;`)
    }
  })

  it('uses current cached source instead of a stale stored graph snippet', () => {
    const oldSource = [
      'export function currentOwner(value: string) {',
      "  if (value === 'old') return null;",
      '  return value;',
      '}',
    ].join('\n') + '\n'
    const fixture = generatedFixture(oldSource)
    const currentSource = oldSource.replace("value === 'old'", "value === 'new'")
    writeFileSync(fixture.sourceFile, currentSource, 'utf8')

    const result = retrieveContext(fixture.graph, {
      question: 'Return exact complete currentOwner source',
      budget: 4_000,
      retrievalLevel: 5,
    })
    const snippet = matchedByLabel(result, 'currentOwner()').snippet
    expect(snippet).toBe(numberedLines(currentSource))
    expect(snippet).not.toContain("value === 'old'")
  }, 120_000)

  it('keeps complete owners atomic at exact and one-token-less snippet budgets', () => {
    const fixture = fixtures.get('pre')!
    const call = PUBLIC_CALLS[1]
    const fresh = () => retrieveContext(fixture.graph, {
      question: call.question,
      budget: call.budget,
      retrievalLevel: 5,
      retrievalStrategy: 'slice-v1',
    })
    const full = fresh()
    const fullSnippet = ownerSnippet(full)!
    const exactCost = estimateQueryTokens(fullSnippet)

    const exact = withRetrieveSnippetBudget(full, {
      snippetBudget: exactCost,
      topNWithSnippet: 12,
    })
    expect(ownerSnippet(exact)).toBe(fullSnippet)
    expect(exact.snippet_budget_tokens_used).toBe(exactCost)
    expect(matchedByLabel(exact, 'parseDecimalRatio()').snippet_truncated).toBe(false)

    const tight = withRetrieveSnippetBudget(fresh(), {
      snippetBudget: exactCost - 1,
      topNWithSnippet: 12,
    })
    expect(ownerSnippet(tight)).not.toBe(fullSnippet)
    expect(ownerSnippet(tight)).not.toBeNull()
    expect(matchedByLabel(tight, 'parseDecimalRatio()').snippet_truncated).toBe(true)
    expect((matchedByLabel(tight, 'parseDecimalRatio()') as { representation_reason?: string })
      .representation_reason).not.toBe('complete small owner source')
    expect(tight.snippet_budget_tokens_used).toBe(estimateQueryTokens(ownerSnippet(tight)!))

    const restored = withRetrieveSnippetBudget(tight, {
      snippetBudget: exactCost,
      topNWithSnippet: 12,
    })
    expect(ownerSnippet(restored)).toBe(fullSnippet)
    expect(matchedByLabel(restored, 'parseDecimalRatio()').snippet_truncated).toBe(true)

    const roundTrip = JSON.parse(JSON.stringify(restored)) as RetrieveResult
    expect(Object.keys(matchedByLabel(roundTrip, 'parseDecimalRatio()'))
      .some((key) => /complete|fallback|owner/i.test(key))).toBe(false)
    const reshapedRoundTrip = withRetrieveSnippetBudget(roundTrip, {
      snippetBudget: exactCost,
      topNWithSnippet: 12,
    })
    expect(ownerSnippet(reshapedRoundTrip)).toBe(fullSnippet)
    expect(matchedByLabel(reshapedRoundTrip, 'parseDecimalRatio()').snippet_truncated).toBe(true)
  }, 120_000)

  it('omits atomic owners safely for zero snippet budget and top-N', () => {
    const fixture = fixtures.get('pre')!
    const fresh = () => retrieveContext(fixture.graph, {
      question: PUBLIC_CALLS[1].question,
      budget: 3_000,
      retrievalLevel: 5,
      retrievalStrategy: 'slice-v1',
    })
    for (const options of [
      { snippetBudget: 0, topNWithSnippet: 12 },
      { snippetBudget: 2_400, topNWithSnippet: 0 },
    ]) {
      const shaped = withRetrieveSnippetBudget(fresh(), options)
      expect(ownerSnippet(shaped)).toBeNull()
      expect(matchedByLabel(shaped, 'parseDecimalRatio()').snippet_truncated).toBe(true)
      expect(shaped.snippet_budget_tokens_used).toBe(0)
    }
  }, 120_000)

  it('reconciles two complete owners against one shared snippet budget', () => {
    const source = [
      'export function amberOwner(value: string) {',
      "  if (value === '') return null;",
      '  return value.trim();',
      '}',
      'export function cobaltOwner(value: string) {',
      "  if (value === '') return null;",
      '  return value.toUpperCase();',
      '}',
    ].join('\n') + '\n'
    const fixture = generatedFixture(source)
    const fresh = retrieveContext(fixture.graph, {
      question: 'Return complete exact source of amberOwner and cobaltOwner',
      budget: 4_000,
      retrievalLevel: 5,
    })
    const owners = fresh.matched_nodes.filter((node) => (
      node.label === 'amberOwner()' || node.label === 'cobaltOwner()'
    ))
    expect(owners).toHaveLength(2)
    const costs = owners.map((node) => estimateQueryTokens(node.snippet!))
    const budget = costs[0]! + costs[1]! - 1
    const shaped = withRetrieveSnippetBudget(fresh, {
      snippetBudget: budget,
      topNWithSnippet: fresh.matched_nodes.length,
    })
    const shapedOwners = shaped.matched_nodes.filter((node) => (
      node.label === 'amberOwner()' || node.label === 'cobaltOwner()'
    ))
    expect(shapedOwners[0]?.snippet).toBe(owners[0]?.snippet)
    expect(shapedOwners[1]?.snippet).not.toBe(owners[1]?.snippet)
    expect(shapedOwners[1]?.snippet_truncated).toBe(true)
    expect(shaped.snippet_budget_tokens_used).toBe(
      shaped.matched_nodes.reduce((total, node) => total + estimateQueryTokens(node.snippet ?? ''), 0),
    )
    expect(shaped.snippet_budget_tokens_used).toBeLessThanOrEqual(budget)
  }, 120_000)

  it('preserves complete owners and truncation history through compact stdio shaping', () => {
    const fixture = fixtures.get('post')!
    const retrieved = retrieveContext(fixture.graph, {
      question: PUBLIC_CALLS[4].question,
      budget: 2_400,
      retrievalLevel: 5,
    })
    const fullSnippet = ownerSnippet(retrieved)!
    const exactCost = estimateQueryTokens(fullSnippet)
    const compact = compactRetrieveResultForStdio(retrieved, {
      snippetBudget: exactCost - 1,
      topNWithSnippet: 12,
    })
    const compactOwner = matchedByLabel(compact, 'parseDecimalRatio()')
    expect(compactOwner.snippet).not.toBe(fullSnippet)
    expect(compactOwner.snippet_truncated).toBe(true)
    expect(compact.snippet_budget_tokens_used).toBe(
      compact.matched_nodes.reduce((total, node) => total + estimateQueryTokens(node.snippet ?? ''), 0),
    )
  }, 120_000)
})
