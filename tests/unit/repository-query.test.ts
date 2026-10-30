import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { extractJs } from '../../src/pipeline/extract.js'
import { retrieveContext, retrieveContextAsync } from '../../src/runtime/retrieve.js'
import { prepareRepositoryQuery, repositoryEvidenceQuestion, repositoryQueryKey } from '../../src/runtime/retrieve/repository-query.js'
import { sourceBodyQueryTerms, sourceQueryLiterals } from '../../src/runtime/retrieve/source-evidence.js'
import * as manifests from '../../src/shared/package-manifest.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })

function fixture(indexed = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'madar-repository-query-'))); roots.push(root)
  const packagePath = join(root, 'package.json')
  writeFileSync(packagePath, JSON.stringify({ name: 'ledgergarden' }))
  const graph = new KnowledgeGraph({ directed: true }); graph.graph.root_path = root
  if (indexed) graph.addNode('package', { label: 'package.json', source_file: packagePath, file_type: 'config' })
  return { root, packagePath, graph }
}
const question = 'Trace credit refund and durable attempt state in LedgerGarden, including recovery behavior.'

describe('repository-framed source evidence', () => {
  it('uses only indexed current repository identity and preserves the lexical vocabulary', () => {
    const { graph } = fixture()
    for (const prompt of [question, 'How does LedgerGarden refund credit and recover pending attempts?']) {
      const binding = prepareRepositoryQuery(graph, prompt, 'explain')!
      expect(binding).toBeDefined()
      expect(binding.rawQuestion).toBe(prompt)
      expect(binding.effectiveQuestion).toBe(prompt.replace('LedgerGarden', 'Ledger Garden'))
      expect(sourceQueryLiterals(binding.effectiveQuestion)).not.toContain('LedgerGarden')
      expect(sourceBodyQueryTerms(binding.effectiveQuestion)).toEqual(sourceBodyQueryTerms(prompt))
    }
    expect(prepareRepositoryQuery(fixture(false).graph, question, 'explain')).toBeUndefined()
    expect(prepareRepositoryQuery(graph, 'In the LedgerGarden source, trace refunds.', 'explain')).toBeUndefined()
  })

  it('preserves explicit occurrences, ambiguous symbols and unsupported framing', () => {
    const { graph } = fixture()
    for (const prompt of [
      'Find the LedgerGarden implementation.', 'How does LedgerGarden() refund credit?',
      'How does LedgerGarden.refund work?', 'Trace credit in src/LedgerGarden.ts, including retries.',
      'Trace credit in `LedgerGarden`, including retries.', `"${question}"`, `\`\`\`text\n${question}\n\`\`\``,
      question + ' Also find LedgerGarden().', question + ' Also find the LedgerGarden symbol.',
      question.replace('LedgerGarden,', 'OtherGarden,'),
    ]) expect(prepareRepositoryQuery(graph, prompt, 'explain'), prompt).toBeUndefined()
    graph.addNode('same_name', { label: 'LedgerGarden()', source_file: join(String(graph.graph.root_path), 'worker.ts'), file_type: 'code' })
    expect(prepareRepositoryQuery(graph, question, 'explain')).toBeUndefined()
  })

  it('checks original configuration and path restrictions before reading the manifest', () => {
    const { graph, packagePath } = fixture(), read = vi.spyOn(manifests, 'readPackageManifest')
    for (const suffix of [' Do not read package.json.', ` Do not read ${packagePath}.`, ' Ignore configuration files.']) {
      expect(prepareRepositoryQuery(graph, question + suffix, 'explain'), suffix).toBeUndefined()
    }
    expect(prepareRepositoryQuery(graph, question, 'implement')).toBeUndefined()
    expect(prepareRepositoryQuery(graph, question, 'review')).toBeUndefined()
    expect(read).not.toHaveBeenCalled()
  })

  it('declines wrong, malformed, ignored and symlinked package identities', () => {
    const { graph, root, packagePath } = fixture()
    for (const text of ['{', '{"name":"othergarden"}', '{"name":"@scope/ledgergarden"}', '{"name":"LedgerGarden"}', '{"name":7}']) {
      writeFileSync(packagePath, text)
      expect(prepareRepositoryQuery(graph, question, 'explain')).toBeUndefined()
    }
    writeFileSync(packagePath, '{"name":"ledgergarden"}')
    writeFileSync(join(root, '.madarignore'), 'package.json\n')
    expect(prepareRepositoryQuery(graph, question, 'explain')).toBeUndefined()
    rmSync(join(root, '.madarignore')); rmSync(packagePath)
    const other = fixture(); symlinkSync(other.packagePath, packagePath)
    expect(prepareRepositoryQuery(graph, question, 'explain')).toBeUndefined()
  })

  it('keeps private evidence binding copy-safe, request-bound and fresh without serializing it', () => {
    const { graph, root, packagePath } = fixture(), binding = prepareRepositoryQuery(graph, question, 'explain')!
    const result = { question, task_contract: { task_kind: 'explain', prompt: binding.effectiveQuestion }, [repositoryQueryKey]: binding }
    expect(repositoryEvidenceQuestion({ ...result }, root)).toBe(binding.effectiveQuestion)
    expect(JSON.parse(JSON.stringify(result))[repositoryQueryKey]).toBeUndefined()
    expect(repositoryEvidenceQuestion({ ...result, question: question + ' Changed.' }, root)).toBe(question + ' Changed.')
    expect(repositoryEvidenceQuestion(result, fixture().root)).toBe(question)
    expect(repositoryEvidenceQuestion({ ...result, [repositoryQueryKey]: { ...binding } }, root)).toBe(question)
    expect(repositoryEvidenceQuestion({ ...result, task_contract: { task_kind: 'review', prompt: binding.effectiveQuestion } }, root)).toBe(question)
    const before = manifests.capturePackageSourceSnapshot([packagePath], root)
    writeFileSync(packagePath, '{"name":"othergarden"}')
    expect(repositoryEvidenceQuestion(result, root)).toBe(question)
    expect(manifests.packageSourceSnapshotsMatch(before, manifests.capturePackageSourceSnapshot([packagePath], root))).toBe(false)
    writeFileSync(packagePath, '{"name":"ledgergarden"}')
    writeFileSync(join(root, '.madarignore'), 'package.json\n')
    expect(repositoryEvidenceQuestion(result, root)).toBe(question)
  })

  it('shares the evidence interpretation across synchronous and asynchronous retrieval while returning the raw question', async () => {
    const { graph, root } = fixture()
    const source = join(root, 'settle.ts')
    writeFileSync(source, 'export function settleAttempt(attempt: any) {\n  if (attempt.state === "reserved") { attempt.state = "refunded"; attempt.credit += 1; }\n  return attempt;\n}\n')
    const brands = join(root, 'branding.ts')
    writeFileSync(brands, Array.from({ length: 140 }, (_, index) => `export function brand${index}() { return "LedgerGarden"; }`).join('\n'))
    for (const file of [source, brands]) for (const node of extractJs(file).nodes) graph.addNode(node.id, node)
    const options = { question, taskKind: 'explain' as const, budget: 2000 }
    const sync = retrieveContext(graph, options), asyncResult = await retrieveContextAsync(graph, options)
    for (const result of [sync, asyncResult]) {
      expect(result.question).toBe(question)
      expect(repositoryEvidenceQuestion(result, root)).toBe(question.replace('LedgerGarden', 'Ledger Garden'))
      expect(result.matched_nodes.some(node => node.label === 'settleAttempt()')).toBe(true)
    }
    expect(asyncResult.matched_nodes.map(node => node.node_id)).toEqual(sync.matched_nodes.map(node => node.node_id))
  })
})
