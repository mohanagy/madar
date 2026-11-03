import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { sourceDiagnosticMethodFragment, type DiagnosticFragmentClause } from '../../src/runtime/retrieve/source-diagnostic-fragments.js'
import { renderSourceFragment } from '../../src/runtime/retrieve/source-fragments.js'
import { createSourceContinuationPreparation } from '../../src/runtime/source-continuation.js'
import { extractJs } from '../../src/pipeline/extract.js'
import { buildFromJson } from '../../src/pipeline/build.js'
import { searchSourceBodyQuestions, sourceDiagnosticAlternativesKey, sourceDiagnosticClauseEvidence } from '../../src/runtime/retrieve/source-evidence.js'
import { sourceDiagnosticQueries, sourceDiagnosticContextsKey, sourceDiagnosticSeeds, sourceDiagnosticFragmentsKey, type SourceDiagnosticClauseMatches } from '../../src/runtime/retrieve/source-diagnostic-priority.js'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
const fixture = [
  'export function makeBoundary(options: any) {',
  '  const secret = options.secret;',
  '  return {',
  '    resolve(input: any) {',
  '      if (!input.tenant || !input.audience) throw new Error("invalid");',
  '      if (!input.subject || !input.chat) return undefined;',
  '      return { tenant: input.tenant, audience: input.audience, subject: input.subject, chat: input.chat };',
  '    },',
  '    reset() {',
  '      return { siblingAlpha: secret, siblingBeta: secret };',
  '    }',
  '  };',
  '}',
]
function parsed(lines = fixture) {
  const content = lines.join('\n'), source = ts.createSourceFile('factory.ts', content, ts.ScriptTarget.Latest, true)
  const declaration = source.statements.find(ts.isFunctionDeclaration)!
  const clause = (families: string[]): DiagnosticFragmentClause => ({
    families,
    spans: [...content.matchAll(/\b[A-Za-z][A-Za-z0-9]*\b/g)].filter(match => families.includes(match[0])).map(match => ({
      start: match.index!, end: match.index! + match[0].length,
      startLine: source.getLineAndCharacterOfPosition(match.index!).line + 1,
      endLine: source.getLineAndCharacterOfPosition(match.index! + match[0].length - 1).line + 1,
    })),
  })
  const hash = createHash('sha256').update(content).digest('hex')
  return { content, source, declaration, clause, hash }
}

describe('diagnostic returned-object method fragments', () => {
  it('binds real bounded clause witnesses to the proved original factory before materialization', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'madar-diagnostic-fragment-search-'))); roots.push(root)
    const file = join(root, 'factory.ts')
    const question = 'Trace request boundary: how tenant and audience are checked; whether subject and chat are checked.'
    const run = (lines: string[], heading = true) => {
      writeFileSync(file, lines.join('\n'))
      // This fixture deliberately indexes the factory owner, as opposed to a
      // separate callable alias for its returned object methods.
      const node = extractJs(file).nodes.find(node => node.label === 'makeBoundary()')!
      const graph = buildFromJson({ schema_version: 1, nodes: [node], edges: [] }, { directed: true })
      graph.graph.root_path = root
      const clauses = sourceDiagnosticQueries(question), cache = new Map<string, string[] | null>()
      const searches = searchSourceBodyQuestions(graph, [question, ...clauses], root, cache, {
        allowedOwner: () => true,
        ...(heading ? { contexts: clauses[sourceDiagnosticContextsKey]! } : {}),
      })
      const matches: SourceDiagnosticClauseMatches = Object.assign(searches.slice(1).map(search => search.matches), {
        [sourceDiagnosticAlternativesKey]: searches[0]![sourceDiagnosticAlternativesKey] ?? [],
      })
      const seeds = sourceDiagnosticSeeds([{ id: node.id, label: node.label, sourceFile: file,
        sourceLocation: String(node.source_location), sourceDomain: 'production' }], matches, () => true, root, cache)
      return { id: node.id, matches, fragments: seeds[sourceDiagnosticFragmentsKey] }
    }
    const actual = run(fixture)
    expect(actual.matches).toHaveLength(2)
    for (const matches of actual.matches) expect(sourceDiagnosticClauseEvidence(matches)?.owners.has(actual.id)).toBe(true)
    expect(actual.fragments?.has(actual.id)).toBe(true)
    expect(run(fixture, false).fragments?.size ?? 0).toBe(0)
    expect(run(fixture.map(line => line.replace('options: any', 'options: any = { tenant: "t", audience: "a" }'))).fragments?.size ?? 0).toBe(0)
    expect(run(fixture.map(line => line.replace('siblingAlpha: secret', 'subject: secret'))).fragments?.size ?? 0).toBe(0)
  })

  it('keeps every assigned clause in a complete method with the original factory continuation', () => {
    const { content, declaration, clause, hash } = parsed()
    const fragment = sourceDiagnosticMethodFragment(declaration, fixture, hash,
      [clause(['tenant', 'audience']), clause(['subject', 'chat'])], { visited: 0, limit: 100_000 })!
    expect(fragment).toBeDefined()
    expect(fragment.range).toEqual({ start: 1, end: 13 })
    const rendered = renderSourceFragment(fixture, fragment.range, fragment)!
    expect(rendered.snippet).toContain(fixture.slice(3, 8).join('\n'))
    expect(rendered.omittedRanges).toEqual([{ start_line: 2, end_line: 2 }, { start_line: 9, end_line: 11 }])
    expect(rendered.snippet).toContain('export function makeBoundary(options: any) {')
    expect(rendered.snippet).toContain('  return {')
    expect(rendered.snippet.endsWith('  };\n}')).toBe(true)
    expect(renderSourceFragment([...fixture, '// changed'], fragment.range, fragment)).toBeUndefined()

    const root = realpathSync(mkdtempSync(join(tmpdir(), 'madar-diagnostic-fragment-'))); roots.push(root)
    writeFileSync(join(root, 'factory.ts'), content)
    const preparation = createSourceContinuationPreparation(root, undefined, () => true, { verifyAllSources: true })({
      task: 'explain', pack: { matched_nodes: [{ node_id: 'factory', label: 'makeBoundary()', source_file: 'factory.ts',
        snippet: rendered.snippet, snippet_scope: 'symbol', snippet_line_range: rendered.lineRange,
        snippet_omitted_ranges: rendered.omittedRanges, snippet_truncated: true }] },
    })
    expect(preparation.valid).toBe(true)
    expect(preparation.refused).toBe(false)
    const handle = [...preparation.handles.values()][0]!
    expect(handle.node_id).toBe('factory')
    expect(handle.label).toBe('makeBoundary()')
    expect(handle.owner_range).toEqual({ start_line: 1, end_line: 13 })
    expect(handle.pending_ranges).toEqual(rendered.omittedRanges)
    expect(preparation.validate()).toBe(true)
    writeFileSync(join(root, 'factory.ts'), content.replace('options.secret', 'options.changed'))
    expect(preparation.validate()).toBe(false)
  })

  it('declines when any assigned executable witness or supported lexical boundary would be lost', () => {
    const { declaration, clause, hash } = parsed()
    const keep = clause(['tenant', 'audience'])
    const attempt = (clauses: DiagnosticFragmentClause[]) => sourceDiagnosticMethodFragment(declaration, fixture, hash,
      clauses, { visited: 0, limit: 100_000 })
    expect(attempt([keep, clause(['siblingAlpha', 'siblingBeta'])])).toBeUndefined()
    expect(attempt([keep, clause(['secret', 'tenant'])])).toBeUndefined()
    expect(attempt([clause(['tenant'])])).toBeUndefined()
    for (const lines of [
      fixture.map(line => line.replace('reset()', 'resolve()')),
      fixture.map(line => line.replace('reset()', '["reset"]()')),
      [...fixture.slice(0, 1), '  if (!options) return undefined;', ...fixture.slice(1)],
      fixture.map(line => line.replace('options: any', 'options: any = { tenant: "t", audience: "a" }')),
    ]) {
      const value = parsed(lines)
      expect(sourceDiagnosticMethodFragment(value.declaration, lines, value.hash,
        [value.clause(['tenant', 'audience'])], { visited: 0, limit: 100_000 })).toBeUndefined()
    }
    expect(sourceDiagnosticMethodFragment(declaration, fixture, hash, [keep], { visited: 100_000, limit: 100_000 })).toBeUndefined()
  })
})
