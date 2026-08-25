/**
 * Produces a genuine mutation-evidence matrix for controls to work on.
 *
 * Hand-written artifact fixtures were how the audit came to be weaker than it
 * looked: a stub set can only ever satisfy the checks its author remembered.
 * These helpers run the REAL harness against a stand-in runner, so every
 * control starts from evidence the harness actually produced -- one green
 * baseline and one caught mutant -- and breaks exactly one thing.
 */
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const HARNESS = resolve(REPO, 'scripts/verify-integrity-mutations.mjs')
const STUB = resolve(REPO, 'tests/fixtures/mutation-vitest-stub.mjs')

export const TARGET = 'src/target.ts'
export const SUITE = 'tests/unit/suite.test.ts'
export const MARKER = '__MUTATED__'
export const TEST_NAME = 'stub invariant test'
export const MUTANT_NAME = 'demo mutant'

export interface EvidenceMatrix {
  /** The stand-in project the harness ran in. */
  readonly project: string
  /** The run-scoped artifact root: one baseline and one mutant. */
  readonly runRoot: string
}

/** Where scratch projects are created, so a control can measure its own leak. */
export const SCRATCH_PREFIX = 'madar-evidence-golden-'

/** Runs the harness once and returns where its evidence landed. */
export function produceEvidenceMatrix(
  options: { harness?: string; exactFailureSet?: boolean } = {},
): EvidenceMatrix {
  const harness = options.harness ?? HARNESS
  const project = mkdtempSync(resolve(tmpdir(), SCRATCH_PREFIX))
  mkdirSync(resolve(project, 'src'), { recursive: true })
  mkdirSync(resolve(project, 'tests/unit'), { recursive: true })
  writeFileSync(resolve(project, TARGET), "export const KEEP = 'ORIGINAL_VALUE'\n")
  writeFileSync(resolve(project, SUITE), '// stand-in; the stub decides the verdict\n')
  writeFileSync(resolve(project, 'mutants.json'), JSON.stringify([{
    name: MUTANT_NAME,
    file: TARGET,
    test: SUITE,
    from: "'ORIGINAL_VALUE'",
    to: `'${MARKER}'`,
    expect: [TEST_NAME],
    // Declared exactly as the real harness declares the shared-policy mutant,
    // so a control exercising exact-set attribution runs against genuine
    // harness-produced evidence rather than a hand-assembled shape.
    ...(options.exactFailureSet === true ? { exactFailureSet: true } : {}),
  }]))

  try {
    const child = spawnSync(process.execPath, [harness, '--mutants', 'mutants.json'], {
      cwd: project,
      encoding: 'utf8',
      env: {
        ...process.env,
        MADAR_MUTATION_VITEST_ARGV: JSON.stringify([process.execPath, STUB]),
        MADAR_STUB_TARGET: TARGET,
        MADAR_STUB_MARKER: MARKER,
        MADAR_STUB_TEST_NAME: TEST_NAME,
      },
    })
    if (child.status !== 0) {
      throw new Error(`harness failed (${child.status}): ${child.stdout ?? ''}${child.stderr ?? ''}`)
    }

    const runs = resolve(project, 'node_modules/.cache/madar-mutations')
    const [runId] = readdirSync(runs)
    return { project, runRoot: resolve(runs, runId as string) }
  } catch (error) {
    // The caller only learns the project path from a successful return, so a
    // throw here strands the directory forever. That is exactly what happened:
    // a mutant that made the harness exit non-zero left one scratch project
    // per suite behind, on every matrix arm.
    discardMatrix(project)
    throw error
  }
}

/**
 * A private, byte-identical copy of a matrix.
 *
 * Timestamps are preserved deliberately: the audit binds artifacts to their
 * invocation window, and a copy that reset every mtime would trip that check
 * before any control had a chance to.
 */
export function copyMatrix(runRoot: string): string {
  const root = mkdtempSync(resolve(tmpdir(), 'madar-evidence-copy-'))
  const target = resolve(root, 'matrix')
  cpSync(runRoot, target, { recursive: true, preserveTimestamps: true })
  return target
}

/** Locates the baseline or the mutant invocation inside a matrix. */
export function matrixDir(root: string, kind: 'mutant' | 'baseline'): string {
  const names = readdirSync(root)
  const name = kind === 'baseline'
    ? names.find((entry) => entry.includes('baseline'))
    : names.find((entry) => !entry.includes('baseline'))
  if (name === undefined) throw new Error(`no ${kind} invocation in ${root}`)
  return resolve(root, name)
}

/** Removes a produced project, including a target a control left read-only. */
export function discardMatrix(project: string): void {
  try { chmodSync(resolve(project, TARGET), 0o644) } catch { /* already writable */ }
  rmSync(project, { recursive: true, force: true })
}
