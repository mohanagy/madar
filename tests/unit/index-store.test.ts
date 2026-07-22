import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it } from 'vitest'

import {
  acquireIndexLease,
  loadAcceptedIndex,
  readMatchingDiagnostics,
  type PublicationStep,
} from '../../src/adapters/filesystem/index-store.js'
import { generateIndex, SourceChangedDuringBuildError } from '../../src/application/generate-index.js'
import { IndexLeaseContentionError } from '../../src/domain/index/build-state.js'

const roots: string[] = []

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'madar-index-store-'))
  roots.push(root)
  const source = join(root, 'src', 'main.ts')
  mkdirSync(dirname(source), { recursive: true })
  writeFileSync(source, 'export const value = 1\n', 'utf8')
  return root
}

function graphBytes(root: string): string {
  return readFileSync(join(root, 'out', 'graph.json'), 'utf8')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('index store publication', () => {
  it.each<PublicationStep>([
    'before_report',
    'after_report',
    'before_diagnostics',
    'after_diagnostics',
    'before_cleanup',
    'after_cleanup',
  ])('keeps derived %s failures non-blocking', (failedStep) => {
    const root = fixture()
    const result = generateIndex(root, {
      storeDependencies: {
        hook(step) {
          if (step === failedStep) throw new Error(`injected ${step}`)
        },
      },
    })

    expect(loadAcceptedIndex(result.graphPath)?.state.build_id).toBe(result.buildId)
    expect(result.notes.join(' ')).toContain('unavailable')
  })

  it('exposes no accepted artifact when the first graph commit fails', () => {
    const root = fixture()
    const graphPath = join(root, 'out', 'graph.json')

    expect(() => generateIndex(root, {
      storeDependencies: {
        hook(step) {
          if (step === 'before_graph_commit') throw new Error('commit unavailable')
        },
      },
    })).toThrow(/commit unavailable/)
    expect(loadAcceptedIndex(graphPath)).toBeNull()
  })

  it('retains the previous accepted graph when a replacement commit fails', () => {
    const root = fixture()
    const accepted = generateIndex(root)
    const before = graphBytes(root)
    writeFileSync(join(root, 'src', 'main.ts'), 'export const value = 2\n', 'utf8')

    expect(() => generateIndex(root, {
      storeDependencies: {
        hook(step) {
          if (step === 'before_graph_commit') {
            expect(graphBytes(root)).toBe(before)
            throw new Error('replacement commit unavailable')
          }
        },
      },
    })).toThrow(/replacement commit unavailable/)

    expect(graphBytes(root)).toBe(before)
    expect(loadAcceptedIndex(accepted.graphPath)?.state.build_id).toBe(accepted.buildId)
    // Diagnostics may have advanced first, but a mismatch cannot authorize them.
    expect(readMatchingDiagnostics(accepted.graphPath)).toBeNull()
  })

  it('rejects a real source edit at the graph commit boundary', () => {
    const root = fixture()
    const accepted = generateIndex(root)
    const before = graphBytes(root)
    const source = join(root, 'src', 'main.ts')
    writeFileSync(source, 'export const value = 2\n', 'utf8')

    expect(() => generateIndex(root, {
      storeDependencies: {
        hook(step) {
          if (step === 'before_graph_commit') writeFileSync(source, 'export const value = 3\n', 'utf8')
        },
      },
    })).toThrow(SourceChangedDuringBuildError)

    expect(graphBytes(root)).toBe(before)
    expect(loadAcceptedIndex(accepted.graphPath)?.state.build_id).toBe(accepted.buildId)
    expect(readMatchingDiagnostics(accepted.graphPath)).toBeNull()
  })

  it('reports a post-commit fault without pretending the publication rolled back', () => {
    const root = fixture()
    const first = generateIndex(root)
    writeFileSync(join(root, 'src', 'main.ts'), 'export const value = 2\n', 'utf8')

    const next = generateIndex(root, {
      storeDependencies: {
        hook(step) {
          if (step === 'after_graph_commit') throw new Error('post-commit observer failed')
        },
      },
    })

    expect(next.buildId).not.toBe(first.buildId)
    expect(loadAcceptedIndex(next.graphPath)?.state.build_id).toBe(next.buildId)
    expect(next.notes.join(' ')).toContain('after graph publication')
  })

  it('accepts the graph when diagnostics are missing or mismatched', () => {
    const root = fixture()
    const generated = generateIndex(root)
    const diagnosticsPath = join(root, 'out', 'indexing-manifest.json')
    const accepted = loadAcceptedIndex(generated.graphPath)
    expect(accepted?.state.build_id).toBe(generated.buildId)

    rmSync(diagnosticsPath)
    expect(readMatchingDiagnostics(generated.graphPath)).toBeNull()
    expect(loadAcceptedIndex(generated.graphPath)?.state.build_id).toBe(generated.buildId)

    writeFileSync(diagnosticsPath, JSON.stringify({ version: 1, build_id: '0'.repeat(64) }), 'utf8')
    expect(readMatchingDiagnostics(generated.graphPath)).toBeNull()
    expect(loadAcceptedIndex(generated.graphPath)?.state.build_id).toBe(generated.buildId)
  })

  it('allows only one local build lease owner', () => {
    const root = fixture()
    const outputDir = join(root, 'out')
    const release = acquireIndexLease(outputDir)
    try {
      expect(() => acquireIndexLease(outputDir)).toThrow(IndexLeaseContentionError)
    } finally {
      release()
    }
    const next = acquireIndexLease(outputDir)
    next()
  })

  it('serializes cluster-only publication through the same build lease', () => {
    const root = fixture()
    const generated = generateIndex(root)
    const before = graphBytes(root)
    const release = acquireIndexLease(join(root, 'out'))
    try {
      expect(() => generateIndex(root, { clusterOnly: true })).toThrow(IndexLeaseContentionError)
    } finally {
      release()
    }
    expect(graphBytes(root)).toBe(before)
    expect(loadAcceptedIndex(generated.graphPath)?.state.build_id).toBe(generated.buildId)
  })
})
