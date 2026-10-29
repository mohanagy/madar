import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildSpi } from '../../src/pipeline/spi/build.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { handleStdioRequest } from '../../src/runtime/stdio-server.js'
import { builtinCapabilityRegistry } from '../../src/infrastructure/capabilities.js'
import { resolveSourceSnippet } from '../../src/runtime/source-evidence-response.js'
import { analyzeGraphContextFreshness } from '../../src/runtime/freshness.js'
import { loadGraph } from '../../src/runtime/serve.js'
import { snapshotWatchedFiles } from '../../src/infrastructure/watch.js'
import { classifyFile } from '../../src/pipeline/detect.js'

const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); vi.unstubAllEnvs() })

describe('JavaScript ES module discovery', () => {
  it('indexes an mjs-only project and serves the executing function through MCP', async () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-mjs-')); roots.push(root)
    writeFileSync(join(root, 'package.json'), '{"type":"module"}')
    writeFileSync(join(root, 'rates.mjs'), 'export function taxRate() { return 0.05; }\n')
    writeFileSync(join(root, 'invoice.mjs'), 'import { taxRate } from "./rates.mjs";\nexport function invoiceTotal(amount) {\n  return amount * (1 + taxRate());\n}\n')
    expect(classifyFile(join(root, 'invoice.mjs'))).toBe('code')
    expect(builtinCapabilityRegistry.resolveExtractorForPath(join(root, 'invoice.mjs'), 'code')?.id).toBe('builtin:extract:javascript')
    const generated = generateGraph(root, { noHtml: true, includeDocs: false, docs: false, extractionMode: 'auto' })
    const graph = JSON.parse(readFileSync(generated.graphPath, 'utf8')) as { nodes: Array<{ label: string; source_file: string }> }
    expect(graph.nodes.some(node => node.label === 'invoiceTotal()' && node.source_file.endsWith('invoice.mjs'))).toBe(true)
    expect(graph.nodes.some(node => node.label === 'taxRate()' && node.source_file.endsWith('rates.mjs'))).toBe(true)
    vi.stubEnv('MADAR_TOOL_PROFILE', 'strict')
    const response = await handleStdioRequest(generated.graphPath, { id: 1, method: 'tools/call', params: {
      name: 'context_pack', arguments: { prompt: 'Show invoiceTotal', task: 'explain', budget: 2000 },
    } })
    expect(response?.error).toBeUndefined()
    const payload = JSON.parse((response?.result as { content: Array<{ text: string }> }).content[0]!.text)
    expect(JSON.stringify(payload.pack)).toContain('return amount * (1 + taxRate())')
    expect(payload.serialized_budget.token_count).toBeLessThanOrEqual(2000)
  })

  it.each([
    { extension: '.mjs', runtimeExtension: '.mjs', commonJs: false, typed: false },
    { extension: '.ts', runtimeExtension: '.js', commonJs: false, typed: true },
    { extension: '.js', runtimeExtension: '.js', commonJs: true, typed: false },
    { extension: '.cjs', runtimeExtension: '.cjs', commonJs: true, typed: false },
    { extension: '.mts', runtimeExtension: '.mjs', commonJs: false, typed: true },
    { extension: '.cts', runtimeExtension: '.cjs', commonJs: true, typed: true },
  ])('indexes, retrieves and tracks $extension module implementations', async ({ extension, runtimeExtension, commonJs, typed }) => {
    const root = mkdtempSync(join(tmpdir(), 'madar-module-extension-')); roots.push(root)
    const invoiceFile = join(root, `invoice${extension}`)
    const rateFile = join(root, `rates${extension}`)
    const importStatement = commonJs && typed
      ? `import rates = require('./rates${runtimeExtension}');`
      : commonJs
        ? `const { taxRate } = require('./rates${runtimeExtension}');`
        : `import { taxRate } from './rates${runtimeExtension}';`
    const invoiceBody = `function invoiceTotal(amount${typed ? ': number' : ''}) {\n  return amount * (1 + ${commonJs && typed ? 'rates.taxRate' : 'taxRate'}());\n}`
    const rateBody = `function taxRate()${typed ? ': number' : ''} {\n  return 0.05;\n}`
    const invoice = `${importStatement}\n${commonJs && !typed ? '' : 'export '}${invoiceBody}\n${commonJs && !typed ? 'module.exports = { invoiceTotal };\n' : ''}`
    writeFileSync(invoiceFile, invoice)
    writeFileSync(rateFile, `${commonJs && !typed ? '' : 'export '}${rateBody}\n${commonJs && !typed ? 'module.exports = { taxRate };\n' : ''}`)
    // A same-name function must not substitute for the source module binding.
    writeFileSync(join(root, `metrics${extension}`), `${commonJs ? '' : 'export '}function taxRate() { return 999; }\n`)
    if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
      const sibling = extension === '.cjs' ? '.cts' : '.mts'
      writeFileSync(join(root, `rates${sibling}`), 'export function taxRate(): number { return 666; }\n')
    }
    if (extension === '.mts' || extension === '.cts') {
      // The explicit runtime suffix must select .mts/.cts, even with a .ts sibling.
      writeFileSync(join(root, 'rates.ts'), 'export function taxRate(): number { return 777; }\n')
    }
    expect(classifyFile(invoiceFile)).toBe('code')
    expect(builtinCapabilityRegistry.resolveExtractorForPath(invoiceFile, 'code')?.id)
      .toBe(`builtin:extract:${typed ? 'typescript' : 'javascript'}`)
    const generated = generateGraph(root, { noHtml: true })
    const graph = loadGraph(generated.graphPath)
    const indexedFiles = new Set(graph.nodeEntries().map(([, node]) => node.source_file))
    expect(indexedFiles.has(invoiceFile)).toBe(true)
    expect(indexedFiles.has(rateFile)).toBe(true)
    expect(analyzeGraphContextFreshness(generated.graphPath, graph).status).toBe('fresh')
    vi.stubEnv('MADAR_TOOL_PROFILE', 'strict')
    const response = await handleStdioRequest(generated.graphPath, { id: 1, method: 'tools/call', params: {
      name: 'context_pack', arguments: { prompt: 'Explain invoiceTotal and follow the actual taxRate implementation it calls.', task: 'explain', budget: 3000 },
    } })
    expect(response?.error).toBeUndefined()
    const payload = JSON.parse((response?.result as { content: Array<{ text: string }> }).content[0]!.text)
    const nodes = payload.pack.matched_nodes as Array<Record<string, unknown>>
    const source = nodes.map(node => resolveSourceSnippet(node, nodes) ?? '').join('\n')
    expect(source).toContain(invoiceBody)
    expect(source).toContain(rateBody)
    expect(source).not.toContain('return 999')
    expect(source).not.toContain('return 777')
    expect(source).not.toContain('return 666')
    const caller = nodes.find(node => node.label === 'invoiceTotal()')
    const callee = nodes.find(node => node.label === 'taxRate()')
    expect(payload.pack.relationships).toContainEqual({ from_id: caller?.node_id, to_id: callee?.node_id, relation: 'calls' })
    expect(payload.serialized_budget.token_count).toBeLessThanOrEqual(3000)
    const before = snapshotWatchedFiles(root, false)
    expect(before.fingerprints.has(invoiceFile)).toBe(true)
    writeFileSync(invoiceFile, invoice.replace('amount *', 'amount +'))
    const after = snapshotWatchedFiles(root, false)
    expect(after.fingerprints.get(invoiceFile)).not.toBe(before.fingerprints.get(invoiceFile))
    expect(analyzeGraphContextFreshness(generated.graphPath, graph).changed_source_count).toBe(1)
    expect(analyzeGraphContextFreshness(generated.graphPath, graph).status).not.toBe('fresh')
  })


  it('keeps untyped require bindings in CTS unresolved instead of guessing a same-name function', async () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-cts-require-')); roots.push(root)
    writeFileSync(join(root, 'invoice.cts'), "const { taxRate } = require('./rates.cjs');\nfunction invoiceTotal(amount: number) { return amount * taxRate(); }\nmodule.exports = { invoiceTotal };\n")
    writeFileSync(join(root, 'rates.cts'), 'function taxRate(): number { return 0.05; }\nmodule.exports = { taxRate };\n')
    writeFileSync(join(root, 'metrics.cts'), 'export function taxRate(): number { return 999; }\n')
    const generated = generateGraph(root, { noHtml: true })
    vi.stubEnv('MADAR_TOOL_PROFILE', 'strict')
    const response = await handleStdioRequest(generated.graphPath, { id: 1, method: 'tools/call', params: {
      name: 'context_pack', arguments: { prompt: 'Explain invoiceTotal and follow its actual calls.', task: 'explain', budget: 3000 },
    } })
    expect(response?.error).toBeUndefined()
    const payload = JSON.parse((response?.result as { content: Array<{ text: string }> }).content[0]!.text)
    const nodes = payload.pack.matched_nodes as Array<Record<string, unknown>>
    const source = nodes.map(node => resolveSourceSnippet(node, nodes) ?? '').join('\n')
    expect(source).toContain('return amount * taxRate()')
    expect(source).not.toContain('return 999')
    expect(payload.pack.source_dependencies.unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'unresolved', callee: 'taxRate' }),
    ]))
  })


  it.each([
    { specifier: './rates.js', wrongExtension: '.mts' },
    { specifier: './rates.jsx', wrongExtension: '.cts' },
  ])('does not resolve missing $specifier to a $wrongExtension module', async ({ specifier, wrongExtension }) => {
    const root = mkdtempSync(join(tmpdir(), 'madar-module-kind-')); roots.push(root)
    writeFileSync(join(root, 'invoice.ts'), `import { taxRate } from '${specifier}';\nexport function invoiceTotal(amount: number) { return amount * taxRate(); }\n`)
    writeFileSync(join(root, `rates${wrongExtension}`), 'export function taxRate(): number { return 999; }\n')
    const generated = generateGraph(root, { noHtml: true })
    vi.stubEnv('MADAR_TOOL_PROFILE', 'strict')
    const response = await handleStdioRequest(generated.graphPath, { id: 1, method: 'tools/call', params: {
      name: 'context_pack', arguments: { prompt: 'Explain invoiceTotal and its actual calls.', task: 'explain', budget: 3000 },
    } })
    expect(response?.error).toBeUndefined()
    const payload = JSON.parse((response?.result as { content: Array<{ text: string }> }).content[0]!.text)
    const nodes = payload.pack.matched_nodes as Array<Record<string, unknown>>
    expect(nodes.map(node => resolveSourceSnippet(node, nodes) ?? '').join('\n')).not.toContain('return 999')
    expect(payload.pack.source_dependencies.unresolved_calls).toBeGreaterThan(0)
    expect(buildSpi({ root, madarVersion: '0.0.0-test' }).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining(`Unresolved relative import "${specifier}"`) }),
    ]))
  })

})
