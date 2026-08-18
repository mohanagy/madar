import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { executeCli } from '../../src/cli/main.js'
import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { GRAPH_ARTIFACT_V2_TOMBSTONE } from '../../src/contracts/graph-artifact.js'
import { GraphArtifactStateError, classifyWorkspaceGraph } from '../../src/contracts/graph-artifact-selection.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { runBenchmark } from '../../src/infrastructure/benchmark.js'
import { evaluateRetrievalQuality } from '../../src/infrastructure/benchmark/quality.js'

/**
 * Negative controls for the measurement gates.
 *
 * The tombstone is a non-empty file at the path every gate used to test for, so
 * after the cutover "the graph is there" stopped being evidence that anything
 * was measured. A gate that still keys on presence would report a passing
 * threshold for a workspace holding no graph at all -- the worst possible
 * failure for a gate whose entire job is to catch regressions.
 *
 * Each case below removes the canonical artifact and leaves the tombstone, then
 * requires the gate to refuse. The paired positive control is what proves the
 * refusal is about the missing artifact and not a broken command.
 */

/** Printed only if the exec template runs, which it must never do here. */
const EXEC_MARKER = 'madar-eval-exec-ran'

function captureIo(): { io: { log: (m: string) => void, error: (m: string) => void }, text: () => string } {
  const lines: string[] = []
  return {
    io: { log: (m: string) => lines.push(String(m)), error: (m: string) => lines.push(String(m)) },
    text: () => lines.join('\n'),
  }
}

describe('measurement gates refuse a tombstone-only workspace', () => {
  let root: string
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
    root = mkdtempSync(join(tmpdir(), 'bench-gate-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(
      join(root, 'src', 'a.ts'),
      'export function alpha() { beta() }\nexport function beta() {}\n',
    )
    // A real cutover, then the canonical artifact goes missing -- the shape a
    // failed or partial publication leaves behind.
    generateGraph(root, { noHtml: true })
    unlinkSync(join(root, 'out', 'graph.madar'))
    process.chdir(root)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(root, { recursive: true, force: true })
  })

  it('starts from a non-empty tombstone with no canonical artifact', () => {
    // Both halves matter: presence-based gates pass because of the first, and
    // the second is what makes that pass meaningless.
    expect(readFileSync(join(root, 'out', 'graph.json'), 'utf8')).toBe(GRAPH_ARTIFACT_V2_TOMBSTONE)
    expect(readFileSync(join(root, 'out', 'graph.json'), 'utf8').length).toBeGreaterThan(0)
    expect(classifyWorkspaceGraph(join(root, 'out')).state).toBe('moved_without_canonical')
  })

  it('the eval gate fails instead of scoring the tombstone', async () => {
    writeFileSync(join(root, 'questions.json'), JSON.stringify(['how does alpha work?']))
    const { io, text } = captureIo()

    // The CI step's own invocation shape. The exec template is a command that
    // fails loudly if it ever runs: reaching a prompt at all would mean the
    // gate had already decided it had a graph to measure.
    const exitCode = await executeCli(
      ['eval', '--questions', 'questions.json', '--exec', 'node -e "console.log(\'madar-eval-exec-ran\'); process.exit(97)"', '--yes'],
      io,
    )

    expect(exitCode).not.toBe(0)
    expect(text()).toMatch(/graph\.madar/)
    expect(text()).not.toMatch(/Recall:/)
    // Keyed on the marker the exec prints, not on the bare number 97: the
    // refusal text carries a random mkdtemp suffix and can contain counts, so a
    // digit match could pass or fail for reasons unrelated to the exec.
    expect(text()).not.toContain(EXEC_MARKER)
  })

  it('the benchmark gate fails instead of reporting thresholds', async () => {
    const { io, text } = captureIo()

    const exitCode = await executeCli(
      ['benchmark', '--exec', 'node -e "console.log(\'madar-eval-exec-ran\'); process.exit(97)"', '--yes'],
      io,
    )

    expect(exitCode).not.toBe(0)
    expect(text()).toMatch(/graph\.madar/)
  })

  it('runBenchmark with no path classifies rather than assuming the default', () => {
    // The default used to be spelled in the signature and declared explicit,
    // which skipped classification: an absent argument resolved to a path the
    // workspace did not have and the failure surfaced later as a read error.
    expect(() => runBenchmark()).toThrow(GraphArtifactStateError)
    try {
      runBenchmark()
      expect.unreachable('runBenchmark resolved a tombstone-only workspace')
    } catch (error) {
      expect(error).toBeInstanceOf(GraphArtifactStateError)
      expect((error as GraphArtifactStateError).state).toBe('moved_without_canonical')
    }
  })

  it('the runner-backed quality gate refuses rather than naming a path it has not got', async () => {
    // Reached with a graph already in memory and no path supplied -- the shape
    // that made this gate resolve its own default. Declaring that absent
    // argument explicit skipped classification and produced a graph.madar path
    // for a workspace that has none, which then travelled into retrieval
    // provenance and the prompt artifacts as if it had been measured.
    const graph = new KnowledgeGraph()
    graph.addNode('alpha', { label: 'alpha', file_type: 'code', source_file: 'src/a.ts', source_location: 'L1' })
    graph.addNode('beta', { label: 'beta', file_type: 'code', source_file: 'src/a.ts', source_location: 'L2' })
    graph.addEdge('alpha', 'beta', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/a.ts' })

    await expect(evaluateRetrievalQuality(
      graph,
      [{ question: 'how does alpha work?', expected_labels: ['alpha'] }],
      3000,
      { execTemplate: 'node -e "console.log(\'madar-eval-exec-ran\'); process.exit(97)"' },
    )).rejects.toThrow(GraphArtifactStateError)
  })

  it('runs the same gates once the canonical artifact is restored', async () => {
    generateGraph(root, { noHtml: true })
    expect(classifyWorkspaceGraph(join(root, 'out')).state).toBe('current_v2')

    // Positive control: the refusals above are about the missing artifact.
    const result = runBenchmark()
    expect(typeof result).not.toBe('undefined')

    const { io } = captureIo()
    expect(await executeCli(['summary'], io)).toBe(0)
  })
})

describe('the protected workflows consume the canonical artifact', () => {
  const workflow = (name: string): string =>
    readFileSync(join(process.cwd(), '.github', 'workflows', name), 'utf8')

  it('runs eval against graph.madar and never against graph.json', () => {
    const ci = workflow('ci.yml')
    const evalLine = ci.split('\n').find((line) => line.includes('bin.js eval'))

    expect(evalLine).toBeDefined()
    expect(evalLine).toContain('out/graph.madar')
    expect(evalLine).not.toContain('out/graph.json')
  })

  it('checks the prerelease artifact by content, not by size', () => {
    const publish = workflow('publish-next.yml')

    // `test -s out/graph.json` is the check this replaced: it passes on the
    // tombstone, so it could not fail even with no graph produced.
    expect(publish).not.toMatch(/test -s "\$workspace\/out\/graph\.json"/)
    expect(publish).toContain('out/graph.madar')
    expect(publish).toMatch(/MADAR_GRAPH_ARTIFACT\/2/)
    expect(publish).toMatch(/cmp -s "\$workspace\/out\/graph\.json"/)
  })
})
