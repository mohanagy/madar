import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Full generation is the documented repair for an ambiguous workspace, so it
 * must rebuild from source without consulting either artifact.
 *
 * This asserts the rule directly because on the full-generate path the read is
 * incidental: its result is only used by --update and --cluster-only, both of
 * which now refuse the mixed state outright. Removing the guard therefore
 * changes no output, and only an observation of the call itself can tell the
 * two apart.
 */
const policyReads: string[] = []

vi.mock('../../src/infrastructure/generation-policy.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/infrastructure/generation-policy.js')>()
  return {
    ...real,
    readGraphGenerationPolicy: (graphPath: string) => {
      policyReads.push(graphPath)
      return real.readGraphGenerationPolicy(graphPath)
    },
  }
})

const { generateGraph } = await import('../../src/infrastructure/generate.js')
const { classifyWorkspaceGraph } = await import('../../src/contracts/graph-artifact-selection.js')

afterEach(() => {
  policyReads.length = 0
})

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'mixed-noload-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), 'export function a() { b() }\nexport function b() {}\n')
  return root
}

describe('repairing a mixed workspace consults neither artifact', () => {
  it('reads no generation policy from the ambiguous graphs', () => {
    const root = workspace()
    try {
      generateGraph(root, { noHtml: true })
      const out = join(root, 'out')
      writeFileSync(
        join(out, 'graph.json'),
        JSON.stringify({ schema_version: 1, directed: true, nodes: [{ id: 'stale' }], links: [] }),
      )
      expect(classifyWorkspaceGraph(out).state).toBe('mixed_v2_and_live_v1')

      policyReads.length = 0
      generateGraph(root, { noHtml: true })

      expect(classifyWorkspaceGraph(out).state).toBe('current_v2')
      expect(policyReads).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('still reads the stored policy for an unambiguous workspace', () => {
    const root = workspace()
    try {
      generateGraph(root, { noHtml: true })

      // The recorder is live and the guard is scoped to the ambiguous state,
      // so a healthy workspace still consults its own graph. Without this the
      // assertion above would hold even if the mock were inert.
      policyReads.length = 0
      generateGraph(root, { noHtml: true })

      expect(policyReads.length).toBeGreaterThan(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
