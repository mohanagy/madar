// v0.18 — `sadeem generate --spi` opt-in pipeline.
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

  it('framework_role + route_path flow end-to-end into graph.json with --spi', () => {
    // Confirms the v0.18 user-visible win: the SPI projector tags
    // Express route handlers with framework=express + framework_role=
    // express_route + node_kind=route + route_path, and the graph.json
    // serializer preserves all of these as plain node attributes.
    writeFile(sandbox, 'src/server.ts', [
      'import express from "express"',
      'export const app = express()',
      'export function listUsers(): void {}',
      'app.get("/users", listUsers)',
    ].join('\n') + '\n')

    const result = generateGraph(sandbox, { useSpi: true, noHtml: true })
    const parsed = JSON.parse(readFileSync(result.graphPath, 'utf8')) as {
      nodes: Array<Record<string, unknown>>
    }
    const listUsersNode = parsed.nodes.find((n) => n.label === 'listUsers()')
    expect(listUsersNode).toBeDefined()
    expect(listUsersNode?.framework).toBe('express')
    expect(listUsersNode?.framework_role).toBe('express_route')
    expect(listUsersNode?.node_kind).toBe('route')
    expect(listUsersNode?.route_path).toBe('/users')
  })

  it('uses the SPI cache on the second call (notes include "cache hit")', () => {
    writeFile(sandbox, 'src/foo.ts', 'export function foo(): number { return 1 }\n')

    const first = generateGraph(sandbox, { useSpi: true, noHtml: true })
    expect(first.notes.some((n) => n.includes('SPI build'))).toBe(true)

    const second = generateGraph(sandbox, { useSpi: true, noHtml: true })
    expect(second.notes.some((n) => n.toLowerCase().includes('cache hit'))).toBe(true)
  })

  it('keeps non-code extraction alongside SPI-projected code and reports only the code subset as cached', () => {
    writeFile(sandbox, 'src/foo.ts', 'export function foo(): number { return 1 }\n')
    writeFile(sandbox, 'docs/notes.md', '# Notes\nGraph docs\n')

    const first = generateGraph(sandbox, { useSpi: true, noHtml: true })
    const firstGraph = JSON.parse(readFileSync(first.graphPath, 'utf8')) as {
      nodes: Array<Record<string, unknown>>
    }
    expect(first.extractableFiles).toBe(2)
    expect(first.extractedFiles).toBe(2)
    expect(first.cache).toEqual(expect.objectContaining({
      strategy: 'spi',
      hit: false,
      reason: 'no-cache',
      fileCount: 1,
    }))
    expect(firstGraph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'foo()', file_type: 'code' }),
        expect.objectContaining({ label: 'notes.md', file_type: 'document' }),
      ]),
    )

    const second = generateGraph(sandbox, { useSpi: true, noHtml: true })
    expect(second.extractableFiles).toBe(2)
    expect(second.extractedFiles).toBe(1)
    expect(second.cache).toEqual(expect.objectContaining({
      strategy: 'spi',
      hit: true,
      reason: 'fresh-cache',
      fileCount: 1,
    }))
  })

  it('useSpi:false (default) still uses the legacy extract pipeline', () => {
    writeFile(sandbox, 'src/foo.ts', 'export function foo(): number { return 1 }\n')

    const result = generateGraph(sandbox, { noHtml: true })

    // No SPI notes in the legacy path.
    const hasSpiNote = result.notes.some((note) => note.toLowerCase().includes('spi'))
    expect(hasSpiNote).toBe(false)
  })
})
