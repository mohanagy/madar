import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handleStdioRequest } from '../../src/runtime/stdio-server.js'

let root = '', graphPath = '', previousProfile: string | undefined
beforeEach(() => {
  previousProfile = process.env.MADAR_TOOL_PROFILE
  root = mkdtempSync(join(tmpdir(), 'madar-full-prompt-'))
  mkdirSync(join(root, 'src')); mkdirSync(join(root, 'out'))
  writeFileSync(join(root, 'src/reset.ts'), [
    'export function startReset() { return "initial"; }',
    'export function finishReset() { return "final-required-tail-evidence"; }',
  ].join('\n'))
  graphPath = join(root, 'out/graph.json')
  writeFileSync(graphPath, JSON.stringify({ directed: true, root_path: root,
    nodes: ['startReset', 'finishReset'].map((label, index) => ({ id: label, label,
      source_file: join(root, 'src/reset.ts'), source_location: `L${index + 1}-L${index + 1}`,
      file_type: 'code', node_kind: 'function', community: 0 })), edges: [], hyperedges: [] }))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  if (previousProfile === undefined) delete process.env.MADAR_TOOL_PROFILE
  else process.env.MADAR_TOOL_PROFILE = previousProfile
})

describe('context_pack full task prompt boundary', () => {
  it.each(['strict', 'full'])('accepts the full long task and retrieves its relevant tail in %s profile', async profile => {
    process.env.MADAR_TOOL_PROFILE = profile
    const prompt = `${'Please inspect the code carefully and ground your response in source evidence. '.repeat(20)}\nWhat does finishReset do in src/reset.ts?`
    expect(prompt.length).toBeGreaterThan(1500)
    const response = await handleStdioRequest(graphPath, { id: 1, method: 'tools/call', params: {
      name: 'context_pack', arguments: { prompt, task: 'explain', budget: profile === 'full' ? 20000 : 3000,
        ...(profile === 'full' ? { verbose: true } : {}) },
    } })
    expect(response).not.toHaveProperty('error')
    const text = (response?.result as { content: Array<{ text: string }> }).content[0]!.text
    const payload = JSON.parse(text)
    expect(payload.pack.matched_nodes).toEqual(expect.arrayContaining([expect.objectContaining({
      label: 'finishReset', snippet: expect.stringContaining('final-required-tail-evidence'),
    })]))
    if (profile === 'full') expect(payload.prompt).toBe(prompt)
  })

  it('rejects oversized task prompts explicitly while keeping the existing small label limit', async () => {
    process.env.MADAR_TOOL_PROFILE = 'full'
    const tooLong = await handleStdioRequest(graphPath, { id: 2, method: 'tools/call', params: {
      name: 'context_pack', arguments: { prompt: 'x'.repeat(32769), task: 'explain' },
    } })
    expect(tooLong?.error).toMatchObject({ code: -32602, message: expect.stringContaining('32768') })
    const label = await handleStdioRequest(graphPath, { id: 3, method: 'tools/call', params: {
      name: 'get_node', arguments: { label: 'x'.repeat(513) },
    } })
    expect(label?.error).toMatchObject({ code: -32602, message: expect.stringContaining('512') })
  })
})
