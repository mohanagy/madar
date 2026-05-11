// v0.18 — `graphify-ts generate --spi` opt-in pipeline.
// Verifies the flag plumbs through parseGenerateArgs and that generateGraph
// actually runs the SPI projector when set.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseGenerateArgs } from '../../src/cli/parser.js'
import { generateGraph } from '../../src/infrastructure/generate.js'

function mkSandbox(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

describe('parseGenerateArgs --spi flag', () => {
  it('defaults useSpi to false', () => {
    const opts = parseGenerateArgs([])
    expect(opts.useSpi).toBe(false)
  })

  it('sets useSpi to true when --spi is present', () => {
    const opts = parseGenerateArgs(['--spi'])
    expect(opts.useSpi).toBe(true)
  })

  it('co-exists with other flags', () => {
    const opts = parseGenerateArgs(['--spi', '--directed', '--no-html'])
    expect(opts.useSpi).toBe(true)
    expect(opts.directed).toBe(true)
    expect(opts.noHtml).toBe(true)
  })
})

describe('generateGraph useSpi:true (v0.18)', () => {
  let sandbox: string
  beforeEach(() => { sandbox = mkSandbox('generate-spi-') })
  afterEach(() => { rmSync(sandbox, { recursive: true, force: true }) })

  it('produces a graph.json via the SPI projector when useSpi is set', () => {
    writeFile(sandbox, 'src/foo.ts', [
      'export function foo(): number { return 1 }',
      'export function bar(): number { return foo() }',
    ].join('\n') + '\n')

    const result = generateGraph(sandbox, { useSpi: true, noHtml: true })

    // Standard graph.json should exist with code nodes for foo + bar.
    expect(existsSync(result.graphPath)).toBe(true)
    expect(result.nodeCount).toBeGreaterThan(0)

    // Notes should reference the SPI pipeline.
    const hasSpiNote = result.notes.some((note) => note.toLowerCase().includes('spi'))
    expect(hasSpiNote).toBe(true)
  })

  it('produces nodes for Express handlers via the SPI pipeline', () => {
    // SPI projector emits an ExtractionNode for every projectable symbol.
    // The full framework_role / route_path propagation through to
    // graph.json depends on the graph serializer preserving arbitrary
    // node attributes — pinned separately by spi-projector-express-parity
    // tests. Here we just verify the SPI pipeline produces a usable
    // graph from an Express sandbox.
    writeFile(sandbox, 'src/server.ts', [
      'import express from "express"',
      'export const app = express()',
      'export function listUsers(): void {}',
      'app.get("/users", listUsers)',
    ].join('\n') + '\n')

    const result = generateGraph(sandbox, { useSpi: true, noHtml: true })
    const raw = readFileSync(result.graphPath, 'utf8')

    expect(result.nodeCount).toBeGreaterThan(0)
    // The handler function should be in graph.json under some shape.
    expect(raw).toContain('listUsers')
  })

  it('uses the SPI cache on the second call (notes include "cache hit")', () => {
    writeFile(sandbox, 'src/foo.ts', 'export function foo(): number { return 1 }\n')

    const first = generateGraph(sandbox, { useSpi: true, noHtml: true })
    expect(first.notes.some((n) => n.includes('SPI build'))).toBe(true)

    const second = generateGraph(sandbox, { useSpi: true, noHtml: true })
    expect(second.notes.some((n) => n.toLowerCase().includes('cache hit'))).toBe(true)
  })

  it('useSpi:false (default) still uses the legacy extract pipeline', () => {
    writeFile(sandbox, 'src/foo.ts', 'export function foo(): number { return 1 }\n')

    const result = generateGraph(sandbox, { noHtml: true })

    // No SPI notes in the legacy path.
    const hasSpiNote = result.notes.some((note) => note.toLowerCase().includes('spi'))
    expect(hasSpiNote).toBe(false)
  })
})
