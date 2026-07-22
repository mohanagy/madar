import { closeSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it } from 'vitest'

import { readGraphArtifactReceipt } from '../../src/adapters/filesystem/graph-artifact.js'
import {
  acquireIndexLease,
  acceptedIndexArtifactsComplete,
  loadAcceptedIndex,
  readMatchingDiagnostics,
  readMatchingReport,
  readMatchingReportReceipt,
  releaseIndexLeaseOwner,
  type PublicationStep,
} from '../../src/adapters/filesystem/index-store.js'
import { generateIndex, SourceChangedDuringBuildError } from '../../src/application/generate-index.js'
import { updateIndex } from '../../src/application/update-index.js'
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

  it('ignores a stale report when replacement report publication fails', () => {
    const root = fixture()
    const first = generateIndex(root)
    expect(readMatchingReport(first.graphPath)).toContain(first.buildId)
    writeFileSync(join(root, 'src', 'main.ts'), 'export const value = 2\n', 'utf8')

    const next = generateIndex(root, {
      storeDependencies: {
        hook(step) {
          if (step === 'before_report') throw new Error('report unavailable')
        },
      },
    })

    expect(next.buildId).not.toBe(first.buildId)
    expect(loadAcceptedIndex(next.graphPath)?.state.build_id).toBe(next.buildId)
    expect(readMatchingReport(next.graphPath)).toBeNull()
  })

  it('returns report text and its exact authenticated graph receipt together', () => {
    const generated = generateIndex(fixture())
    const receipt = readMatchingReportReceipt(generated.graphPath)

    expect(receipt).toMatchObject({ buildId: generated.buildId })
    expect(receipt?.report).toBe(readMatchingReport(generated.graphPath))
    expect(receipt?.graphSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(receipt?.graphModifiedMs).toBe(Math.trunc(statSync(generated.graphPath).mtimeMs))
    expect(receipt?.reportModifiedMs).toBe(Math.trunc(statSync(generated.reportPath).mtimeMs))
  })

  it('rejects an oversized authenticated graph report before reading it', () => {
    const generated = generateIndex(fixture())
    truncateSync(generated.reportPath, 5_000_001)

    expect(readMatchingReportReceipt(generated.graphPath)).toBeNull()
  })

  it('binds a report read to a caller-supplied graph publication', () => {
    const root = fixture()
    const first = generateIndex(root)
    const firstReceipt = readGraphArtifactReceipt(first.graphPath)
    writeFileSync(join(root, 'src', 'main.ts'), 'export const value = 2\n')
    const next = generateIndex(root)

    expect(readMatchingReportReceipt(next.graphPath, firstReceipt)).toBeNull()
    expect(readMatchingReportReceipt(next.graphPath)?.buildId).toBe(next.buildId)
  })

  it('repairs missing or mismatched derived artifacts before allowing a cold no-op', () => {
    const root = fixture()
    const generated = generateIndex(root)
    rmSync(generated.reportPath)
    expect(acceptedIndexArtifactsComplete(generated.graphPath)).toBe(false)

    const repaired = updateIndex(root)

    expect(repaired.updateReceipt).toMatchObject({
      mode: 'cold_reconcile',
      fallback_reason: 'accepted_artifact_incomplete',
      previous_build_id: generated.buildId,
      publication_advanced: true,
    })
    expect(acceptedIndexArtifactsComplete(repaired.graphPath)).toBe(true)
    expect(readMatchingReport(repaired.graphPath)).toContain(repaired.buildId)

    const noop = updateIndex(root)
    expect(noop.updateReceipt).toMatchObject({ mode: 'cold_noop', publication_advanced: false })
  })

  it.each(['indexing-manifest.json', 'indexing-manifest.share-safe.json'])(
    'rejects and repairs a bound but structurally incomplete %s',
    (name) => {
      const root = fixture()
      const generated = generateIndex(root)
      const path = join(root, 'out', name)
      const valid = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      writeFileSync(path, JSON.stringify({
        version: valid.version,
        build_id: valid.build_id,
        graph_sha256: valid.graph_sha256,
      }), 'utf8')

      expect(acceptedIndexArtifactsComplete(generated.graphPath)).toBe(false)
      if (name === 'indexing-manifest.json') expect(readMatchingDiagnostics(generated.graphPath)).toBeNull()
      expect(updateIndex(root).updateReceipt).toMatchObject({
        mode: 'cold_reconcile',
        fallback_reason: 'accepted_artifact_incomplete',
        publication_advanced: true,
      })
      expect(acceptedIndexArtifactsComplete(generated.graphPath)).toBe(true)
    },
  )

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

  it('cleans up only the explicitly owned worker lease', () => {
    const outputDir = join(fixture(), 'out'), owner = 'worker-owner-token'
    const release = acquireIndexLease(outputDir, {}, owner)
    releaseIndexLeaseOwner(outputDir, 'different-owner')
    expect(() => acquireIndexLease(outputDir)).toThrow(IndexLeaseContentionError)
    releaseIndexLeaseOwner(outputDir, owner)
    const next = acquireIndexLease(outputDir)
    next(); release()
  })

  it('removes its owned lock when lease initialization cannot write', () => {
    const root = fixture()
    const outputDir = join(root, 'out')

    expect(() => acquireIndexLease(outputDir, {
      write() { throw new Error('injected lease write failure') },
    })).toThrow('injected lease write failure')

    const release = acquireIndexLease(outputDir)
    release()
  })

  it('removes its owned lock when lease initialization cannot finish closing', () => {
    const root = fixture()
    const outputDir = join(root, 'out')

    expect(() => acquireIndexLease(outputDir, {
      close(descriptor) {
        closeSync(descriptor)
        throw new Error('injected lease close failure')
      },
    })).toThrow('injected lease close failure')

    const release = acquireIndexLease(outputDir)
    release()
  })

  it('recovers a malformed lock abandoned before initialization completed', () => {
    const root = fixture()
    const outputDir = join(root, 'out')
    mkdirSync(outputDir, { recursive: true })
    const lockPath = join(outputDir, '.madar-build.lock')
    writeFileSync(lockPath, '', 'utf8')
    const stale = new Date(Date.now() - 10 * 60_000)
    utimesSync(lockPath, stale, stale)

    const release = acquireIndexLease(outputDir)
    release()
  })

  it.each([0, -1])('reclaims a stale lock with invalid numeric pid %i', (pid) => {
    const root = fixture()
    const outputDir = join(root, 'out')
    mkdirSync(outputDir, { recursive: true })
    const lockPath = join(outputDir, '.madar-build.lock')
    writeFileSync(lockPath, JSON.stringify({ pid }), 'utf8')
    const stale = new Date(Date.now() - 10 * 60_000)
    utimesSync(lockPath, stale, stale)

    const release = acquireIndexLease(outputDir)
    release()
  })

  it('recovers when a crashed reclaimer leaves its ownership sentinel', () => {
    const root = fixture()
    const outputDir = join(root, 'out')
    mkdirSync(outputDir, { recursive: true })
    const lockPath = join(outputDir, '.madar-build.lock')
    writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999 }), 'utf8')
    const stale = new Date(Date.now() - 10 * 60_000)
    utimesSync(lockPath, stale, stale)
    const lock = statSync(lockPath)
    writeFileSync(`${lockPath}.reclaim-${lock.dev}-${lock.ino}`, JSON.stringify({ pid: 999_999_999 }), 'utf8')

    const release = acquireIndexLease(outputDir)
    expect(readdirSync(outputDir).filter((name) => name.includes('.reclaim-'))).toEqual([])
    release()
  })

  it('serializes stale-lock reclamation before removing the observed owner', () => {
    const root = fixture()
    const outputDir = join(root, 'out')
    mkdirSync(outputDir, { recursive: true })
    const lockPath = join(outputDir, '.madar-build.lock')
    writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999 }), 'utf8')
    const stale = new Date(Date.now() - 10 * 60_000)
    utimesSync(lockPath, stale, stale)

    const release = acquireIndexLease(outputDir, {
      hook(step) {
        if (step === 'stale_reclaim_claimed') {
          expect(() => acquireIndexLease(outputDir)).toThrow(IndexLeaseContentionError)
        }
      },
    })
    try {
      expect(readdirSync(outputDir).filter((name) => name.includes('.reclaim-'))).toEqual([])
    } finally {
      release()
    }
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
