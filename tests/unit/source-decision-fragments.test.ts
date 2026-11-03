import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { buildFromJson } from '../../src/pipeline/build.js'
import { extractJs } from '../../src/pipeline/extract.js'
import { sourceIncomingDecisionFragment } from '../../src/runtime/retrieve/source-decision-fragments.js'
import { selectSourceDependencies, sourceSelectionProvenanceKey } from '../../src/runtime/retrieve/source-dependencies.js'
import { renderSourceFragment } from '../../src/runtime/retrieve/source-fragments.js'
import { coherentSourceSnippet } from '../../src/runtime/retrieve/source-evidence.js'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

function fixture(change: (text: string) => string = text => text) {
  const root = mkdtempSync(join(tmpdir(), 'madar-decision-fragment-')); roots.push(root)
  const file = join(root, 'dispatch.ts')
  writeFileSync(join(root, 'options.ts'), 'export const defaultPath = "local";')
  const text = change([
    'import { defaultPath } from "./options.js";',
    'function launchPreview(path: string, enabled: boolean) {',
    '  return { path, enabled };',
    '}',
    'export async function execute(action: string, options: { path: string; disable: boolean }) {',
    ...Array.from({ length: 100 }, (_, i) => `  if (action === "unrelated${i}") return ${i};`),
    '  if (action === "publish") {',
    '    await launchPreview(',
    '      options.path,',
    '      options.disable !== true',
    '    );',
    '    return;',
    '  }',
    '  throw new Error("UNKNOWN_ACTION");',
    '}',
  ].join('\n'))
  writeFileSync(file, text)
  const extracted = extractJs(file)
  const graph = buildFromJson({ schema_version: 1, nodes: extracted.nodes, edges: extracted.edges }, { directed: true })
  graph.graph.root_path = root
  const candidates = graph.nodeEntries().map(([id, node]) => ({ id, label: String(node.label), sourceFile: String(node.source_file),
    sourceLocation: typeof node.source_location === 'string' ? node.source_location : null }))
  const caller = candidates.find(candidate => candidate.label === 'execute()')!
  const callee = candidates.find(candidate => candidate.label === 'launchPreview()')!
  const dependencies = selectSourceDependencies(graph, [callee.id], root, new Map(), { includeCallers: true })
  const select = (question = 'When the publish command runs, how is preview enabled and what happens next?', allowed = (_file: string, _label: string, _text: string) => true) =>
    sourceIncomingDecisionFragment([callee], candidates, question, dependencies, () => true, allowed, root)
  return { root, file, text, candidates, caller, callee, dependencies, select }
}

it('retains current incoming decision evidence without dropping existing caller source', () => {
  const value = fixture(), { caller, callee, dependencies } = value
  const before = JSON.stringify(dependencies)
  expect(dependencies[sourceSelectionProvenanceKey]!.admissions).toContainEqual({ node_id: caller.id, role: 'incoming', depth: 0 })
  const selected = value.select()!
  expect(selected).toMatchObject({ callerId: caller.id, calleeId: callee.id })
  const rendered = renderSourceFragment(value.text.split('\n'), selected.fragment.range, selected.fragment)!
  expect(rendered.snippet).toContain('if (action === "publish") {\n    await launchPreview(\n      options.path,\n      options.disable !== true\n    );\n    return;\n  }')
  expect(rendered.snippet).toContain('export async function execute(')
  expect(rendered.snippet.endsWith('}')).toBe(true)
  expect(rendered.snippet).not.toContain('unrelated39')
  expect(rendered.omittedRanges.length).toBeGreaterThan(0)
  expect(selected.fragment.retained.reduce((total, range) => total + range.end_line - range.start_line + 1, 0)).toBeLessThanOrEqual(80)
  const original = coherentSourceSnippet(value.text.split('\n'), selected.fragment.range, 'When the publish command runs, how is preview enabled and what happens next?', 'symbol', value.file)!
  for (let line = selected.fragment.range.start; line <= selected.fragment.range.end; line++) {
    if (!original.omittedRanges.some(gap => gap.start_line <= line && gap.end_line >= line)) {
      expect(selected.fragment.retained.some(range => range.start_line <= line && range.end_line >= line)).toBe(true)
    }
  }
  expect(JSON.stringify(dependencies)).toBe(before)
  // Bounded loading is not whole-program proof; unchanged local identity and
  // complete site/mutation scans suffice for this same-file presentation only.
  const proof = dependencies[sourceSelectionProvenanceKey]!
  proof.scans.program = 'incomplete'; proof.scans.source_loading = 'incomplete'
  expect(value.select()).toBeDefined()
  proof.scans.calls = 'incomplete'
  expect(value.select()).toBeUndefined()
  proof.scans.calls = 'complete'
  expect(value.select('Explain republish behavior and what happens next.')).toBeUndefined()
  expect(value.select('Explain the unknown command; exclude "publish".')).toBeUndefined()
  expect(value.select('Explain execute() for publish and its complete behavior.')).toBeUndefined()
  expect(value.select(undefined, (_file, _label, text) => !text.includes('options.disable'))).toBeUndefined()
  const multiple = value.select('When publish and unrelated80 run, how is preview enabled and what happens next?')!
  const multipleText = renderSourceFragment(value.text.split('\n'), multiple.fragment.range, multiple.fragment)!.snippet
  expect(multipleText).toContain('action === "unrelated80"')
  expect(multipleText).toContain('options.disable !== true')
  expect(sourceIncomingDecisionFragment([callee], [callee], 'Explain publish', dependencies, () => true, () => true, value.root)).toBeUndefined()
  const bundle = dependencies.source_callsite_bundles!.find(entry => entry.from_id === caller.id && entry.to_id === callee.id)!
  const offset = bundle.sites[0]!.start_offset
  bundle.sites[0]!.start_offset++
  expect(value.select()).toBeUndefined()
  bundle.sites[0]!.start_offset = offset
  writeFileSync(value.file, value.text.replace('options.disable !== true', 'options.disable === true'))
  expect(value.select()).toBeUndefined()
  expect(renderSourceFragment(value.text.replace('options.disable !== true', 'options.disable === true').split('\n'), selected.fragment.range, selected.fragment)).toBeUndefined()
  writeFileSync(value.file, value.text)
  writeFileSync(join(value.root, '.madarignore'), 'unrelated.ts\n')
  expect(value.select()).toBeUndefined()

  for (const change of [
    (text: string) => text.replace('action === "publish"', 'action !== "publish"'),
    (text: string) => text.replace('    return;\n  }', '    return;\n  } else { return; }'),
    (text: string) => text.replace('    return;\n  }', '    launchPreview(options.path, false);\n    return;\n  }'),
    (text: string) => text.replace('  if (action === "publish")', '  if (options.disable)\n  if (action === "publish")'),
    (text: string) => text.replace('    return;\n  }', '    return;\n' + '\n'.repeat(35) + '  }'),
    (text: string) => text.replace('  if (action === "publish")', '  const launchPreview = () => 1;\n  if (action === "publish")'),
    (text: string) => text + '\nlaunchPreview = () => ({ path: "", enabled: false });',
  ]) expect(fixture(change).select()).toBeUndefined()
})
