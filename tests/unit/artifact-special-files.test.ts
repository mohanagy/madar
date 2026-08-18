import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  GraphArtifactNotRegularFileError,
  GraphArtifactTooLargeError,
  NONBLOCKING_READ_FLAGS,
  classifyWorkspaceGraph,
  openRegularArtifactFile,
  readArtifactWithinBound,
} from '../../src/contracts/graph-artifact-selection.js'
import {
  GRAPH_ARTIFACT_V2_HEADER,
  GRAPH_ARTIFACT_V2_TOMBSTONE,
} from '../../src/contracts/graph-artifact-format.js'
import { serializeGraphArtifactV2 } from '../../src/contracts/graph-artifact.js'
import { generatedGraphDiscoverySource } from '../../src/shared/generated-graph-discovery.js'
import { KnowledgeGraph } from '../../src/contracts/graph.js'

/**
 * A graph artifact is an ordinary file, and nothing else may be treated as one.
 *
 * `openSync(path, 'r')` on a FIFO with no writer waits for one, in the calling
 * process, with no timeout. Workspace classification probes `graph.madar`,
 * `graph.json` and the `graph.v1.json` backup on every default load, so a FIFO
 * at any of the three hangs a command outright. The backup path was not opened
 * at all before this work, so that reachability is new here rather than
 * inherited -- measured, not assumed:
 *
 *   B1 base, FIFO at graph.v1.json, default load  -> returned in 736 ms
 *   this head before the fix, same case            -> still blocked at 6 s
 *
 * Every FIFO case below runs in a child process under a parent-side timeout.
 * Reverting the fix must fail these fast and for the stated reason, not hang
 * the suite -- a hanging test is the failure mode this file exists to prevent.
 */
const PROBE_TIMEOUT_MS = 8_000
const isWindows = process.platform === 'win32'

/**
 * Whether this runtime can import the TypeScript sources in a child.
 *
 * The probes must run out of process so a reverted fix fails on a parent-side
 * timeout instead of hanging vitest, and CI runs the suite before `build`, so
 * there is no `dist` to import either. Node 22 strips types natively; Node 20
 * does not, and there the mechanism proof below still runs because it needs no
 * project source at all.
 */
const stripFlags: string[] = []

/**
 * The compiled reader, when a build exists.
 *
 * A child cannot import the TypeScript sources: they import each other with
 * `.js` specifiers and use parameter properties, which Node's strip-only mode
 * rejects. So the end-to-end FIFO probe runs against `dist` and is skipped
 * where there is none -- CI runs this suite before `build`. Nothing essential
 * rests on it: the flags and the non-regular rejection are proven without it.
 */
const distSelection = new URL('../../dist/src/contracts/graph-artifact-selection.js', import.meta.url).href
const hasBuiltDist = existsSync(new URL(distSelection).pathname)

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'artifact-special-'))
  mkdirSync(join(root, 'out'), { recursive: true })
  return root
}

function canonicalBytes(): Buffer {
  const graph = new KnowledgeGraph({ directed: true })
  graph.addNode('a', { label: 'A' })
  graph.addNode('b', { label: 'B' })
  graph.addEdge('a', 'b', { relation: 'calls', confidence: 'EXTRACTED' })
  return serializeGraphArtifactV2({
    graph,
    repositoryRevision: 'rev',
    generationMode: 'full',
    generatedAt: '2026-08-18T00:00:00.000Z',
  })
}

/** Creates a FIFO, or reports that this platform has none. */
function makeFifo(path: string): boolean {
  if (isWindows) return false
  try {
    execFileSync('mkfifo', [path], { stdio: 'pipe', timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

/**
 * Runs one probe in a child and fails if it does not finish in time.
 *
 * The timeout belongs to the parent. A blocking open inside this process would
 * hang vitest itself, which reports as an unattributable suite timeout rather
 * than as this contract being broken.
 */
function probe(source: string): string {
  return execFileSync(process.execPath, [...stripFlags, '--input-type=module', '-e', source], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    stdio: 'pipe',
    windowsHide: true,
  }).trim()
}



describe('special files are never treated as graph artifacts', () => {
  it.skipIf(isWindows)('opens a FIFO with the production flags without waiting', () => {
    // The flags the production opener actually uses, exercised in a child.
    // Reverting them to a plain read open makes this child block, the parent
    // kill it at the timeout, and the failure name this contract -- which is
    // the point of running it out of process. The sources import with `.js`
    // specifiers, so a child cannot load the TypeScript directly and CI runs
    // the suite before `build`; passing the resolved flag value across the
    // boundary tests the same thing without needing either.
    const root = workspace()
    try {
      const fifo = join(root, 'out', 'graph.madar')
      expect(makeFifo(fifo)).toBe(true)

      const out = probe(`
        import { closeSync, fstatSync, openSync } from 'node:fs'
        const fd = openSync(${JSON.stringify(fifo)}, ${NONBLOCKING_READ_FLAGS})
        const regular = fstatSync(fd).isFile()
        closeSync(fd)
        console.log(regular ? 'regular' : 'not-regular')
      `)

      expect(out).toBe('not-regular')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(isWindows || !hasBuiltDist)('the built reader refuses a FIFO instead of waiting on it', () => {
    // End-to-end against the real compiled reader, in a child under a
    // parent-side timeout. Skipped where there is no build: CI runs this suite
    // before `npm run build`, and the sources cannot be imported directly by a
    // child -- Node's strip-only type support rejects the parameter properties
    // this codebase uses. The properties that make the reader safe are proven
    // unconditionally by the cases above and below, so nothing here depends on
    // this one running.
    const root = workspace()
    try {
      const fifo = join(root, 'out', 'graph.madar')
      expect(makeFifo(fifo)).toBe(true)
      writeFileSync(join(root, 'out', 'graph.json'), GRAPH_ARTIFACT_V2_TOMBSTONE)
      writeFileSync(join(root, 'out', 'graph.v1.json'), '{"schema_version":1}')

      const out = probe(`
        const m = await import(${JSON.stringify(distSelection)})
        try {
          m.readArtifactWithinBound(${JSON.stringify(fifo)}, 1024)
          console.log('returned')
        } catch (error) {
          console.log(error.name)
        }
        console.log(m.classifyWorkspaceGraph(${JSON.stringify(join(root, 'out'))}).state)
      `)

      expect(out.split('\n')[0]).toBe('GraphArtifactNotRegularFileError')
      expect(out.split('\n')[1]).toBe('invalid_current_v2')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(isWindows || !hasBuiltDist)('the built classifier does not wait on a FIFO backup', () => {
    const root = workspace()
    try {
      // The path this work newly opens on every default load.
      expect(makeFifo(join(root, 'out', 'graph.v1.json'))).toBe(true)
      writeFileSync(join(root, 'out', 'graph.madar'), canonicalBytes())
      writeFileSync(join(root, 'out', 'graph.json'), GRAPH_ARTIFACT_V2_TOMBSTONE)

      const out = probe(`
        const m = await import(${JSON.stringify(distSelection)})
        console.log(m.classifyWorkspaceGraph(${JSON.stringify(join(root, 'out'))}).state)
      `)

      expect(out).toBe('current_v2')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(isWindows)('generated host discovery does not block on a FIFO', () => {
    const root = workspace()
    try {
      expect(makeFifo(join(root, 'out', 'graph.madar'))).toBe(true)
      // The generated program is plain JavaScript, so it runs in a child as
      // written -- the same text a host executes on every tool invocation.
      const programPath = join(root, 'discovery.mjs')
      writeFileSync(
        programPath,
        `${generatedGraphDiscoverySource('esm')}\n`
        + `process.stdout.write(classifyMadarWorkspace(${JSON.stringify(join(root, 'out'))}).graphState)\n`,
      )

      const out = execFileSync(process.execPath, [programPath], {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        stdio: 'pipe',
        windowsHide: true,
      }).trim()

      expect(out).not.toBe('current')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a directory', () => {
    const root = workspace()
    try {
      const directory = join(root, 'out', 'graph.madar')
      mkdirSync(directory, { recursive: true })

      expect(() => openRegularArtifactFile(directory)).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('still loads an ordinary canonical artifact', () => {
    const root = workspace()
    try {
      const canonical = join(root, 'out', 'graph.madar')
      writeFileSync(canonical, canonicalBytes())
      writeFileSync(join(root, 'out', 'graph.json'), GRAPH_ARTIFACT_V2_TOMBSTONE)

      const bytes = readArtifactWithinBound(canonical)
      expect(bytes.toString('utf8').startsWith(GRAPH_ARTIFACT_V2_HEADER)).toBe(true)
      expect(classifyWorkspaceGraph(join(root, 'out')).state).toBe('current_v2')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('still classifies an ordinary legacy workspace', () => {
    const root = workspace()
    try {
      writeFileSync(
        join(root, 'out', 'graph.json'),
        JSON.stringify({ schema_version: 1, directed: true, nodes: [], links: [] }),
      )

      expect(classifyWorkspaceGraph(join(root, 'out')).state).toBe('legacy_v1_only')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('still resolves an exact tombstone beside a canonical artifact', () => {
    const root = workspace()
    try {
      writeFileSync(join(root, 'out', 'graph.madar'), canonicalBytes())
      writeFileSync(join(root, 'out', 'graph.json'), GRAPH_ARTIFACT_V2_TOMBSTONE)

      const classification = classifyWorkspaceGraph(join(root, 'out'))
      expect(classification.state).toBe('current_v2')
      expect(classification.canonicalPath).toBe(join(root, 'out', 'graph.madar'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the oversized-artifact refusal intact', () => {
    const root = workspace()
    try {
      const canonical = join(root, 'out', 'graph.madar')
      writeFileSync(canonical, canonicalBytes())

      expect(() => readArtifactWithinBound(canonical, 16)).toThrow(GraphArtifactTooLargeError)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('closes the descriptor when the regular-file check refuses', () => {
    const root = workspace()
    try {
      const directory = join(root, 'out', 'graph.madar')
      mkdirSync(directory, { recursive: true })

      // Repeated refusals must not accumulate descriptors. A leak here would
      // exhaust the process on a host that calls this per tool invocation.
      for (let attempt = 0; attempt < 200; attempt += 1) {
        expect(() => openRegularArtifactFile(directory)).toThrow()
      }
      const canonical = join(root, 'out', 'graph.json')
      writeFileSync(canonical, GRAPH_ARTIFACT_V2_TOMBSTONE)
      expect(readArtifactWithinBound(canonical).byteLength).toBeGreaterThan(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('names the refusal so a caller can act on it', () => {
    const root = workspace()
    try {
      const directory = join(root, 'out', 'graph.madar')
      mkdirSync(directory, { recursive: true })

      let thrown: unknown
      try {
        openRegularArtifactFile(directory)
      } catch (error) {
        thrown = error
      }

      // On POSIX the open itself fails with EISDIR before the fstat runs, so
      // either the typed refusal or a directory errno is correct here. What is
      // asserted is that it refuses rather than proceeding.
      expect(thrown).toBeDefined()
      const isTyped = thrown instanceof GraphArtifactNotRegularFileError
      const isDirectoryErrno = (thrown as NodeJS.ErrnoException).code === 'EISDIR'
      expect(isTyped || isDirectoryErrno).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
