import { describe, expect, it, vi } from 'vitest'
import {
  createContextExpansionQueryGoal, createContextExpansionQueryRegistry,
} from '../../src/runtime/context-expansion-query.js'
import {
  contextExpansionQueryFingerprint, contextExpansionQuerySelection,
  publishContextExpansionQuerySelections,
} from '../../src/runtime/context-expansion-query-session.js'
import { sourceContinuationHandleId, type SourceContinuationHandle } from '../../src/runtime/source-continuation.js'

const id = 'expand:explain:primary:0123456789ab'
const question = 'Explain amber invoices; violet journals; cobalt receipts.'
const binding = 'logical-root:canonical-root:graph-generation:source-generation'
const page = [{ node_id: 'initial', label: 'initial()', source_file: 'initial.ts',
  snippet: 'export function initial() { return "amber invoices"; }' }]

function stored(prompt = question) {
  const goal = createContextExpansionQueryGoal(prompt, page)
  if (!goal) throw new Error('Fixture requires an actual residual query goal')
  return { prompt, task: 'explain', task_intent: 'explain',
    follow_up: { kind: 'context_pack', task_kind: 'explain', evidence_class: 'primary', node_ids: ['journal', 'receipt'],
      focus_files: ['journal.ts', 'receipt.ts'], focus_ranges: [] },
    query_selection: { goal, binding, page_fingerprint: '0'.repeat(64),
      source_fingerprints: [{ source_file: 'initial.ts', canonical_file: '/workspace/initial.ts',
        fingerprint: contextExpansionQueryFingerprint(page[0]!.snippet) }] } }
}

function response(payload: unknown) {
  return { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } }
}

function fixture() {
  const registry = createContextExpansionQueryRegistry()
  const observe = vi.fn(registry.observe)
  const observed = { observe, resolve: registry.resolve }
  const handles = new Map<string, unknown>()
  const cache = new Map<string, unknown>()
  const publish = (value: unknown, nodes = page) => {
    handles.set(id, value)
    publishContextExpansionQuerySelections(response({ expandable: [{ handle_id: id }], pack: { matched_nodes: nodes } }),
      new Map([[id, value]]), handles, observed)
    return handles.get(id)
  }
  const resolve = (value: unknown, currentBinding = binding) =>
    registry.resolve(id, contextExpansionQueryFingerprint(value), currentBinding)
  return { registry, observe, observed, handles, cache, publish, resolve }
}

describe('query selection at final generic-handle publication', () => {
  it('binds only the first published partial primary and its exact issued pending ranges', () => {
    const owner = (name: string) => {
      const cursor: SourceContinuationHandle = { kind: 'source_continuation', version: 1,
        source_file: `/workspace/${name}.ts`, logical_root: '/workspace', real_root: '/workspace',
        canonical_file: `/workspace/${name}.ts`, file_sha256: '0'.repeat(64), node_id: name, label: `${name}()`,
        scope: 'symbol', owner_range: { start_line: 1, end_line: 6 },
        pending_ranges: [{ start_line: 2, end_line: 3 }, { start_line: 5, end_line: 5 }], evidence: {} }
      return { cursor, node: { node_id: name, label: cursor.label, source_file: `${name}.ts`,
        snippet: `export function ${name}() {\n[omitted lines 2-5]\n}`, snippet_scope: 'symbol', snippet_truncated: true,
        snippet_line_range: cursor.owner_range, snippet_omitted_ranges: [{ start_line: 2, end_line: 5 }],
        source_expand_handle: sourceContinuationHandleId(cursor) } }
    }
    const first = owner('initial'), second = owner('second'), supporting = owner('supporting')
    const value = { ...stored(), query_selection: { ...stored().query_selection,
      primary_node_ids: ['initial', 'second'], source_fingerprints: [first, second, supporting].map(({ cursor }) => ({
        source_file: cursor.source_file, canonical_file: cursor.canonical_file, fingerprint: '1'.repeat(64),
      })) } }
    const nodes = [supporting.node, second.node, first.node]
    const seed = () => {
      const f = fixture()
      for (const item of [first, second, supporting]) f.handles.set(item.node.source_expand_handle, structuredClone(item.cursor))
      return f
    }
    const f = seed(), wire = response({ expandable: [{ handle_id: id }], pack: { matched_nodes: nodes } })
    const before = JSON.stringify(wire)
    f.handles.set(id, value)
    publishContextExpansionQuerySelections(wire, new Map([[id, value]]), f.handles, f.observed)
    const published = f.handles.get(id), handoff = contextExpansionQuerySelection(published)?.source_handoff
    expect(handoff).toEqual({ source_expand_handle: second.node.source_expand_handle, node_id: 'second',
      source_file: 'second.ts', owner_range: second.cursor.owner_range, pending_ranges: second.cursor.pending_ranges,
      cursor_fingerprint: contextExpansionQueryFingerprint(second.cursor) })
    // Line4 was supplied by a sibling; the navigation must not re-add it.
    expect(handoff?.pending_ranges).not.toEqual(second.node.snippet_omitted_ranges)
    expect(JSON.stringify(wire)).toBe(before)
    expect(f.resolve(published)).toBeDefined()
    const changed = structuredClone(published) as { query_selection: { source_handoff: { source_file: string } } }
    changed.query_selection.source_handoff.source_file = 'unpublished.ts'
    expect(f.resolve(changed)).toBeUndefined()
    for (const mode of ['missing-cursor', 'replaced-cursor', 'duplicate-owner', 'retargeted-path', 'no-primary'] as const) {
      const other = seed()
      if (mode === 'missing-cursor') other.handles.delete(second.node.source_expand_handle)
      if (mode === 'replaced-cursor') other.handles.set(second.node.source_expand_handle, { ...second.cursor, label: 'different()' })
      const candidate = mode === 'no-primary' ? { ...value, query_selection: { ...value.query_selection, primary_node_ids: [] } } : value
      const page = mode === 'duplicate-owner' ? [...nodes, second.node]
        : mode === 'retargeted-path' ? [supporting.node, { ...second.node, source_file: 'unpublished.ts' }, first.node] : nodes
      expect(contextExpansionQuerySelection(other.publish(candidate, page))?.source_handoff, mode).toBeUndefined()
    }
    // A new child publication cannot inherit a cursor absent from its own page.
    expect(contextExpansionQuerySelection(f.publish(published, []))?.source_handoff).toBeUndefined()
  })

  it('never observes provisional, culled or errored handle writes', () => {
    const f = fixture(), value = stored(), written = new Map([[id, value]])
    f.handles.set(id, value)
    expect(f.observe).not.toHaveBeenCalled() // Storage alone is not publication.
    const visible = response({ expandable: [{ handle_id: id }], pack: { matched_nodes: page } })
    const discarded = [
      { error: { code: -32603, message: 'Failed before publication' } },
      { result: { ...visible.result, isError: true } },
      response({ pack: { matched_nodes: page } }),
      response({ expandable: [{ handle_id: 'expand:explain:primary:different' }], pack: { matched_nodes: page } }),
    ]
    for (const result of discarded) {
      publishContextExpansionQuerySelections(result, written, f.handles, f.observed)
      expect(f.observe).not.toHaveBeenCalled()
      expect(f.handles.get(id)).toBe(value)
      expect(f.resolve(value)).toBeUndefined()
    }
    // Generic verification/requested IDs have the same semantics without the
    // usual expand prefix; source cursor spelling is not a type discriminator.
    for (const alternate of ['verify-0123456789abcdef', 'requested-navigation-id']) {
      f.handles.set(alternate, value)
      publishContextExpansionQuerySelections(response({ evidence: { answerability: {
        verification_targets: [{ handle_id: alternate }],
      } }, pack: { matched_nodes: page } }), new Map([[alternate, value]]), f.handles, f.observed)
      expect(f.registry.resolve(alternate, contextExpansionQueryFingerprint(f.handles.get(alternate)), binding))
        .toEqual(value.query_selection.goal)
    }
    const sourceCursor = { kind: 'source-continuation', source_file: 'initial.ts' }
    f.handles.set('source-expand:cursor', sourceCursor)
    publishContextExpansionQuerySelections(response({ expandable: [{ handle_id: 'source-expand:cursor' }] }),
      new Map([['source-expand:cursor', sourceCursor]]), f.handles, f.observed)
    expect(f.observe).toHaveBeenCalledTimes(2)
  })

  it('binds the actual published page, reuses exact reissues and ignores reference-only pages', () => {
    const f = fixture(), original = stored(), before = JSON.stringify(original)
    const result = response({ expandable: [{ handle_id: id }], pack: { matched_nodes: page } })
    const wire = JSON.stringify(result)
    f.handles.set(id, original)
    publishContextExpansionQuerySelections(result, new Map([[id, original]]), f.handles, f.observed)
    const published = f.handles.get(id), retained = f.resolve(published)
    expect(retained?.missing_obligations).toEqual(['query:obligation:2', 'query:obligation:3'])
    expect(contextExpansionQuerySelection(published)?.page_fingerprint)
      .toBe(contextExpansionQueryFingerprint([page]))
    expect(published).not.toBe(original)
    expect(JSON.stringify(original)).toBe(before)
    expect(JSON.stringify(result)).toBe(wire)
    expect(f.resolve(original)).toBeUndefined()
    expect(f.resolve(published, 'different-root-or-generation')).toBeUndefined()

    // Cache hydration may create a new object with the same complete context.
    f.cache.set('same-prompt-and-budget', structuredClone(original))
    const repeated = f.publish(structuredClone(f.cache.get('same-prompt-and-budget')))
    expect(f.resolve(repeated)).toBe(retained)
    expect(f.observe).toHaveBeenCalledTimes(2)

    publishContextExpansionQuerySelections(response({ handle_id: id, expandable: [{ handle_id: id }],
      pack: { matched_nodes: [] } }), new Map(), f.handles, f.observed)
    expect(f.observe).toHaveBeenCalledTimes(2)
    expect(f.handles.get(id)).toBe(repeated)
    expect(f.resolve(repeated)).toBe(retained)
  })

  it('never substitutes or revives a conflicting same-ID context after handle/cache eviction', () => {
    const scenarios = ['unmarked', 'prompt', 'scope-order', 'final-page', 'generation', 'concurrent-replacement'] as const
    for (const scenario of scenarios) {
      const f = fixture(), initial = stored(), first = f.publish(initial)
      expect(f.resolve(first)).toEqual(initial.query_selection.goal)
      const next: Record<string, unknown> = scenario === 'prompt'
        ? stored('Explain amber invoices; jade journals; cobalt receipts.') : structuredClone(initial)
      if (scenario === 'unmarked') delete next.query_selection // Retrieve/legacy issue without an advisory goal.
      if (scenario === 'scope-order') next.follow_up = { ...initial.follow_up, node_ids: ['receipt', 'journal'] }
      if (scenario === 'generation') next.query_selection = { ...initial.query_selection, binding: 'changed-generation' }
      let latest: unknown
      if (scenario === 'concurrent-replacement') {
        latest = structuredClone(next)
        f.handles.set(id, latest)
        publishContextExpansionQuerySelections(response({ expandable: [{ handle_id: id }], pack: { matched_nodes: page } }),
          new Map([[id, next]]), f.handles, f.observed)
        expect(f.handles.get(id)).toBe(latest)
      } else {
        latest = f.publish(next, scenario === 'final-page'
          ? [{ ...page[0]!, snippet: 'export function initial() { return "amber invoices changed"; }' }] : page)
      }
      expect(f.resolve(first)).toBeUndefined()
      expect(f.resolve(latest)).toBeUndefined()
      expect(f.resolve(latest, 'changed-generation')).toBeUndefined()

      // External handle/cache lifecycle cannot discard transport-lifetime ambiguity.
      f.cache.set('old-parent', structuredClone(initial))
      const cached = f.cache.get('old-parent')
      f.handles.clear()
      f.cache.clear()
      const hydrated = f.publish(structuredClone(cached))
      expect(f.resolve(hydrated)).toBeUndefined()
      f.handles.delete(id)
      const republished = f.publish(structuredClone(initial))
      expect(f.resolve(republished)).toBeUndefined()
    }
  })
})
