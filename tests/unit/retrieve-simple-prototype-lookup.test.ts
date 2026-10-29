import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { loadGraph } from '../../src/runtime/serve.js'
import { selectVerifiedExplicitPrototypeOwners, sourceRequestedOperations, sourceSimplePrototypeRequests } from '../../src/runtime/retrieve/source-requested-operations.js'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'madar-simple-prototype-'))); roots.push(root)
  const file = join(root, 'boxes.js')
  writeFileSync(file, ['function AlphaBox() {}',
    'AlphaBox.prototype.open = function AlphaBox_open(input) { return input + 1; };',
    'function BetaBox() {}',
    'BetaBox.prototype.close = function BetaBox_close(input) { return input - 1; };'].join('\n'))
  const graph = loadGraph(generateGraph(root, { noHtml: true, includeDocs: false, docs: false }).graphPath)
  const ids = new Set(graph.nodeEntries().map(([id]) => id)), files = new Set([file])
  return { root, file, graph, ids, files }
}
describe('complete simple prototype lookup', () => {
  it('keeps the complex parser unchanged while accepting complete bounded simple lists', () => {
    const q = 'Explain AlphaBox.open() and BetaBox.close() from source.'
    expect(sourceRequestedOperations(q).map(v => v.name)).toEqual(['AlphaBox.open'])
    expect(sourceSimplePrototypeRequests(q).map(v => v.name)).toEqual(['AlphaBox.open', 'BetaBox.close'])
    expect(sourceSimplePrototypeRequests('Please show AlphaBox.open, BetaBox.close(), and AlphaBox.open() from the source code.').map(v => v.name))
      .toEqual(['AlphaBox.open', 'BetaBox.close'])
    expect(sourceSimplePrototypeRequests('Explain AlphaBox.and() and BetaBox.close().').map(v => v.name)).toEqual(['AlphaBox.and', 'BetaBox.close'])
  })
  it('abstains on the whole unsupported list without salvaging a valid prefix', () => {
    const invalid = [
      'Explain AlphaBox.open() and instance.close().', 'Explain AlphaBox.open() and "BetaBox.close()".',
      'Explain AlphaBox.open() and BetaBox.close(input).', 'Explain AlphaBox.open() and BetaBox.close().tail',
      'Explain AlphaBox.open() and BetaBox?.close().', 'Explain AlphaBox.open() and BetaBox.close() are examples.',
      'Explain AlphaBox.open() and', 'Explain AlphaBox.open(),', 'Explain AlphaBox.open() from source only.',
      'Explain ' + Array.from({ length: 9 }, (_, i) => `Box${i}.open()`).join(', '),
      'Explain AlphaBox.open().\n```js\nBetaBox.close()\n```',
    ]
    for (const q of invalid) expect(sourceSimplePrototypeRequests(q), q).toEqual([])
  })
  it('publishes current source only after every explicit name has a verified owner', () => {
    const f = fixture(), cache = new Map<string, string[] | null>()
    const partial = 'Explain AlphaBox.open() and MissingBox.close().'
    expect(selectVerifiedExplicitPrototypeOwners(f.graph, partial, f.root, cache, f.ids, f.files, sourceSimplePrototypeRequests(partial))).toEqual([])
    expect(cache.size).toBe(0)
    const complete = 'Explain AlphaBox.open() and BetaBox.close().'
    const owners = selectVerifiedExplicitPrototypeOwners(f.graph, complete, f.root, cache, f.ids, f.files, sourceSimplePrototypeRequests(complete))
    expect(owners.map(id => f.graph.nodeAttributes(id).label)).toEqual(['AlphaBox.prototype.open()', 'BetaBox.prototype.close()'])
    expect(cache.size).toBe(1)
  })
  it('retains current exclusion and conflicting-snapshot guards for a complete list', () => {
    const f = fixture(), q = 'Explain AlphaBox.open() and BetaBox.close().'
    const cache = new Map<string, string[] | null>([[f.file, ['conflicting snapshot']]])
    expect(selectVerifiedExplicitPrototypeOwners(f.graph, q, f.root, cache, f.ids, f.files, sourceSimplePrototypeRequests(q))).toEqual([])
    expect([...cache]).toEqual([[f.file, ['conflicting snapshot']]])
    writeFileSync(join(f.root, '.madarignore'), 'boxes.js\n')
    const ignored = new Map<string, string[] | null>()
    expect(selectVerifiedExplicitPrototypeOwners(f.graph, q, f.root, ignored, f.ids, f.files, sourceSimplePrototypeRequests(q))).toEqual([])
    expect(ignored.size).toBe(0)
  })
})
