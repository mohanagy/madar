import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prioritizeNextRouteReferences } from '../../src/runtime/retrieve/source-route-references.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(call = "fetch('/api/refund?key=one', { method: 'POST' })") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'madar-route-reference-')))
  roots.push(root)
  const write = (path: string, text: string) => {
    const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); return file
  }
  write('package.json', '{"dependencies":{"next":"16.0.0"}}')
  const ui = write('app/refund/page.tsx', `export function refundView() {\n  return ${call};\n}\n`)
  const route = write('app/api/refund/route.ts', 'export function GET() {\n  return Response.json({ preview: true });\n}\nexport function POST() {\n  return Response.json({ issued: true });\n}\n')
  const unrelated = write('other.ts', 'export function unrelated() { return 1; }\n')
  const candidates = [
    { id: 'other', label: 'unrelated', sourceFile: unrelated, sourceLocation: 'L1-L1' },
    { id: 'view', label: 'refundView', sourceFile: ui, sourceLocation: 'L1-L3' },
    { id: 'get', label: 'GET', sourceFile: route, sourceLocation: 'L1-L3' },
    { id: 'post', label: 'POST', sourceFile: route, sourceLocation: 'L4-L6' },
  ]
  return { root, write, candidates, ui, route }
}
function allocationFixture() {
  const f = fixture("fetch('/api/invoice/export', { method: 'POST' })")
  const route = f.write('app/api/invoice/export/route.ts', 'export function GET() {\n return null;\n}\nexport function POST() {\n const confirmation = authentication(); return Response.json({ confirmation, invoiceExport: invoiceExport() });\n}\n')
  for (const candidate of f.candidates) if (candidate.sourceFile === f.route) candidate.sourceFile = route
  const preview = f.write('app/api/invoice/preview/route.ts', 'export function POST() {\n return invoiceExportPreview();\n}\n')
  const deletion = f.write('app/api/ticket/delete/route.ts', 'export function POST() {\n const confirmation = authentication(); return Response.json({ confirmation });\n}\n')
  const candidates = [
    { id: 'preview', label: 'POST', sourceFile: preview, sourceLocation: 'L1-L3' },
    { id: 'delete', label: 'POST', sourceFile: deletion, sourceLocation: 'L1-L3' },
    ...f.candidates,
  ]
  return { ...f, route, candidates }
}

const focusQuestion = 'Trace invoice export from the preview through POST completion. What authentication is required?'
const allocationIds = ['preview', 'post', 'other', 'view', 'get', 'delete']
const referenceOnlyIds = ['preview', 'delete', 'other', 'post', 'view', 'get']

describe('current static Next route references', () => {
  it('moves only the requested, already admitted method before its current referring owner', () => {
    const f = fixture("Promise.all([fetch(`/api/refund?${query}`), fetch(`/api/refund?${query}`, { method: 'POST' })])")
    const original = f.candidates.slice()
    const result = prioritizeNextRouteReferences(f.candidates, 'Explain refund behavior and POST response proof.', f.root)
    expect(result.map(node => node.id)).toEqual(['other', 'post', 'view', 'get'])
    expect(new Set(result)).toEqual(new Set(f.candidates))
    expect(f.candidates).toEqual(original)
    expect(prioritizeNextRouteReferences(f.candidates, 'Explain the refund page.', f.root)).toBe(f.candidates)
    expect(prioritizeNextRouteReferences(f.candidates, 'Explain GET behavior.', f.root).map(node => node.id)).toEqual(['other', 'get', 'view', 'post'])
    const withoutPost = f.candidates.filter(node => node.id !== 'post')
    expect(prioritizeNextRouteReferences(withoutPost, 'Explain POST behavior.', f.root)).toBe(withoutPost)

    const allocation = allocationFixture()
    const allocated = prioritizeNextRouteReferences(allocation.candidates, focusQuestion, allocation.root)
    const focused = ['delete', 'view', 'post'].map(id => allocation.candidates.find(node => node.id === id)!)
    expect(prioritizeNextRouteReferences(focused, focusQuestion, allocation.root).map(node => node.id)).toEqual(['post', 'view', 'delete'])
    expect(allocated.map(node => node.id)).toEqual(allocationIds)
    expect(new Set(allocated)).toEqual(new Set(allocation.candidates))
    // Slot allocation precedes reference ordering: the UI retains its original
    // position, rather than being pushed behind the displaced deletion owner.
    for (const id of ['other', 'view', 'get']) {
      expect(allocated.findIndex(node => node.id === id)).toBe(allocation.candidates.findIndex(node => node.id === id))
    }
    // Already-earlier referenced handlers still supply positive reference proof.
    const lateView = allocation.candidates.filter(node => node.id !== 'view').concat(allocation.candidates.filter(node => node.id === 'view'))
    expect(prioritizeNextRouteReferences(lateView, focusQuestion, allocation.root).map(node => node.id)).toEqual(['preview', 'post', 'other', 'get', 'delete', 'view'])
  })

  it('leaves unsupported calls, stale identities, ambiguous routes and excluded source unchanged', () => {
    const calls = [
      "fetch('https://example.test/api/refund', { method: 'POST' })",
      "fetch(`/${area}/refund`, { method: 'POST' })",
      "fetch('/api/%2e/refund', { method: 'POST' })",
      "fetch?.('/api/refund', { method: 'POST' })",
      "fetch('/api/refund', { ...options, method: 'POST' })",
      "fetch('/api/refund', { ['method']: 'POST' })",
      "fetch('/api/refund', { method: 'GET', method: 'POST' })",
      "fetch('/api/refund', { method })",
    ]
    for (const call of calls) {
      const f = fixture(call)
      expect(prioritizeNextRouteReferences(f.candidates, 'Explain POST behavior.', f.root), call).toBe(f.candidates)
    }
    const mutations = [
      (f: ReturnType<typeof fixture>) => f.write('app/refund/page.tsx', "export function refundView(fetch) {\n return fetch('/api/refund', { method: 'POST' });\n}\n"),
      (f: ReturnType<typeof fixture>) => { f.write('app/refund/page.tsx', "export function refundView() { return 1 } export function actual() { return fetch('/api/refund', {method:'POST'}) }\n"); f.candidates[1]!.sourceLocation = 'L1' },
      (f: ReturnType<typeof fixture>) => { f.candidates[1]!.sourceLocation = 'L9-L10' },
      (f: ReturnType<typeof fixture>) => f.write('app/api/refund/route.js', 'export function POST() { return null }'),
      (f: ReturnType<typeof fixture>) => f.write('src/app/api/refund/route.ts', 'export function POST() { return null }'),
      (f: ReturnType<typeof fixture>) => f.write('app/(other)/api/refund/route.ts', 'export function POST() { return null }'),
      (f: ReturnType<typeof fixture>) => f.write('app/refund/package.json', '{}'),
      (f: ReturnType<typeof fixture>) => { f.candidates[1]!.sourceFile = f.write('components/refund.ts', "export function refundView() {\n return fetch('/api/refund', { method: 'POST' });\n}\n") },
      (f: ReturnType<typeof fixture>) => f.write('.madarignore', 'app/api/refund/route.ts\n'),
      (f: ReturnType<typeof fixture>) => f.write('package.json', '{"dependencies":{}}'),
    ]
    for (const mutate of mutations) {
      const f = fixture(); mutate(f)
      expect(prioritizeNextRouteReferences(f.candidates, 'Explain POST behavior.', f.root)).toBe(f.candidates)
    }
    const cached = fixture()
    expect(prioritizeNextRouteReferences(cached.candidates, 'Explain POST behavior.', cached.root,
      new Map([[cached.ui, ['export function refundView() {}']]]))).toBe(cached.candidates)

    const allocation = allocationFixture()
    for (const question of [
      'What authentication is required for POST?',
      'Trace invoice export from the preview through POST completion. Separately investigate ticket deletion.',
      'Trace invoice export from the preview through POST completion. Also explain ticket deletion.',
      'Trace invoice export from the preview through POST completion. Compare it with ticket deletion.',
      'Trace invoice and ticket export from the preview through POST completion.',
      'Investigate ticket deletion. Trace invoice export from the preview through POST completion.',
      '"Trace invoice export from the preview". Explain POST behavior.',
      '`Trace invoice export from the preview`. Explain POST behavior.',
    ]) expect(prioritizeNextRouteReferences(allocation.candidates, question, allocation.root).map(node => node.id), question).toEqual(referenceOnlyIds)
    const unreferenced = ['delete', 'preview', 'other', 'view', 'get', 'post'].map(id => allocation.candidates.find(node => node.id === id)!)
    expect(prioritizeNextRouteReferences(unreferenced, focusQuestion, allocation.root).map(node => node.id)).toEqual(['delete', 'preview', 'other', 'post', 'view', 'get'])
    for (const expression of ['persistRecord()', 'invoiceExportable()', '({ note: "invoice export" })']) {
      allocation.write('app/api/invoice/export/route.ts', `export function GET() {\n return null;\n}\nexport function POST() {\n /* invoice export */ return ${expression};\n}\n`)
      expect(prioritizeNextRouteReferences(allocation.candidates, focusQuestion, allocation.root).map(node => node.id), expression).toEqual(referenceOnlyIds)
    }
  })
})
