import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { generateGraph } from '../../src/infrastructure/generate.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'
import * as sourceResponses from '../../src/runtime/source-evidence-response.js'
import { handleStdioRequest } from '../../src/runtime/stdio-server.js'

type Value = Record<string, unknown>
const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })
function fixture() {
  vi.stubEnv('MADAR_TOOL_PROFILE', 'strict')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'madar-callee-targets-'))); roots.push(root)
  const files: Record<string, string> = {
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@payment/*': ['src/payment/*'] } } }),
    'src/payment/index.ts': 'export { inspect } from "./real";\n',
    'src/payment/real.ts': 'export function inspect(value: unknown) {\n  return { value, marker: "REAL_BINDING" };\n}\n',
    'src/decoy.ts': 'export function inspect(value: unknown) {\n  return { value, marker: "WRONG_COLLISION" };\n}\n',
    'src/caller.ts': [
      'import { inspect as scan } from "@payment/index";',
      'import * as validation from "@payment/index";',
      'import { inspect as other } from "./decoy";',
      'export function submit(value: unknown) {', '  return scan(value);', '}',
      'export function namespaced(value: unknown) {', '  return validation.inspect(value);', '}',
      'export function nested(value: unknown) {', '  function later() { return scan(value); }', '  return later;', '}',
      'export function mixed(value: unknown, callback: any) {', '  const first = scan(value);',
      '  { const scan = callback; return scan(first); }', '}',
      'export function textOnly() {', '  return "scan(1)"; // scan(2)', '}',
      'export function dynamic(value: unknown) {', '  return validation["inspect"](value);', '}',
      'export function header(value = scan(1)) {', '  const scan = other;', '  return scan(value);', '}',
      'export function binding({value = scan(1)} = {}) {', '  const scan = other;', '  return scan(value);', '}',
    ].join('\n'),
  }
  for (const [file, text] of Object.entries(files)) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text) }
  const graphPath = generateGraph(root, { noHtml: true, includeDocs: false, docs: false }).graphPath
  const state: NonNullable<Parameters<typeof handleStdioRequest>[2]> = {
    logLevel: 'info', subscribedResourceUris: new Set(), resourceVersions: new Map(), resourceListSignature: null, contextPackHandles: new Map(),
  }
  let id = 0
  const request = (targets: Value[], prompt = 'Read these exact current functions. Do not read environment files.') => ({ prompt, targets, task: 'explain', budget: 2000 })
  const response = (args: Value) => handleStdioRequest(graphPath, { id: ++id, method: 'tools/call', params: { name: 'context_pack', arguments: args } }, state)
  const call = async (args: Value) => {
    const result = await response(args)
    expect(result?.error).toBeUndefined()
    const text = (result!.result as { content: Array<{ text: string }> }).content[0]!.text
    const payload = JSON.parse(text)
    expect(payload.serialized_budget).toEqual({ max_tokens: args.budget, token_count: estimateQueryTokens(text), enforced: true })
    expect(estimateQueryTokens(text)).toBeLessThanOrEqual(Number(args.budget))
    return payload
  }
  const target = (symbol: string, callee?: string): Value => ({ file: 'src/caller.ts', symbol, ...(callee !== undefined ? { callee } : {}) })
  return { root, files, state, request, response, call, target }
}

describe('exact caller targets with a named local callee', () => {
  it('follows aliased/barrel and namespace bindings without global-name collisions or changing ordinary targets', async () => {
    const f = fixture()
    const payload = await f.call(f.request([f.target('submit', 'scan'), f.target('namespaced', 'validation.inspect')]))
    expect(payload.pack.matched_nodes).toHaveLength(1)
    expect(payload.pack.matched_nodes[0]).toMatchObject({ source_file: 'src/payment/real.ts', label: 'inspect()' })
    expect(payload.pack.matched_nodes[0].snippet).toContain('REAL_BINDING')
    expect(JSON.stringify(payload)).not.toContain('WRONG_COLLISION')
    expect(payload.pack.relationships ?? []).toEqual([])
    expect(payload.evidence.answerability).toMatchObject({ state: 'insufficient', answer_scope: 'partial', advisory: true })
    const ordinary = await f.call(f.request([f.target('submit')]))
    expect(ordinary.pack.matched_nodes).toHaveLength(1)
    expect(ordinary.pack.matched_nodes[0]).toMatchObject({ source_file: 'src/caller.ts', label: 'submit()' })
    expect(ordinary.pack.matched_nodes[0].snippet).toContain('scan(value)')

    for (const [symbol, callee] of [['nested', 'scan'], ['mixed', 'scan'], ['textOnly', 'scan'], ['dynamic', 'validation.inspect'], ['header', 'scan'], ['binding', 'scan'], ['submit', 'scan()'], ['submit', 'validation["inspect"]']]) {
      const before = [...f.state.contextPackHandles!]
      const refused = await f.response(f.request([f.target(symbol!, callee!)]))
      expect(refused?.error, `${symbol}:${callee}`).toBeDefined()
      expect(refused?.result).toBeUndefined()
      expect([...f.state.contextPackHandles!]).toEqual(before)
    }
    for (const prompt of ['Read submit. Do not read tsconfig.json.', 'Read submit. Do not read src/payment/real.ts.']) {
      const refused = await f.response(f.request([f.target('submit', 'scan')], prompt))
      expect(refused?.error).toBeDefined()
      expect(refused?.result).toBeUndefined()
    }
  })

  it('refuses publication when import or config changes after assembly, including a deduplicated ordinary target', async () => {
    for (const changed of ['src/payment/index.ts', 'tsconfig.json']) {
      const f = fixture(), original = readFileSync(join(f.root, changed), 'utf8')
      const serialize = sourceResponses.finalizeSourceEvidenceResponse
      let changedOnce = false
      const spy = vi.spyOn(sourceResponses, 'finalizeSourceEvidenceResponse').mockImplementation((input, budget, options) => {
        const output = serialize(input, budget, options)
        if (!changedOnce) {
          changedOnce = true
          writeFileSync(join(f.root, changed), changed.endsWith('index.ts') ? 'export { inspect } from "../decoy";\n'
            : JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@payment/*': ['src/elsewhere/*'] } } }))
        }
        return output
      })
      const result = await f.response(f.request([{ file: 'src/payment/real.ts', symbol: 'inspect' }, f.target('submit', 'scan')]))
      spy.mockRestore()
      expect(changedOnce).toBe(true)
      expect(result?.error).toBeDefined()
      expect(result?.result).toBeUndefined()
      expect(f.state.contextPackHandles!.size).toBe(0)
      writeFileSync(join(f.root, changed), original)
    }
  })
})
