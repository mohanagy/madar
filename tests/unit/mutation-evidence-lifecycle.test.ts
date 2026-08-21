/**
 * Controls for the mutation harness's own evidence.
 *
 * An independent review found every mutant record in two 95-invocation matrices
 * claiming `pre == mutated == post`: the harness restored the file and THEN
 * read the "mutated" digest, so all three fields were the same reading of the
 * same restored bytes, presented as a lifecycle. Nothing in the harness noticed,
 * because nothing checked.
 *
 * These controls drive the real harness end to end against a small mutant table
 * of their own, and read the artifacts it actually writes. Asserting about the
 * harness by reading its source is the same class of mistake as the defect:
 * a check that exists and does not check.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const HARNESS = resolve(REPO, 'scripts/verify-integrity-mutations.mjs')
const STUB = resolve(REPO, 'tests/fixtures/mutation-vitest-stub.mjs')

const TARGET = 'src/target.ts'
const SUITE = 'tests/unit/suite.test.ts'
const PRISTINE = "export const KEEP = 'ORIGINAL_VALUE'\n"
const MARKER = '__MUTATED__'
const TEST_NAME = 'stub invariant test'

const scratches: string[] = []
afterEach(() => {
  while (scratches.length > 0) {
    const dir = scratches.pop() as string
    // A restoration-failure control leaves the target read-only on purpose.
    try { chmodSync(resolve(dir, TARGET), 0o644) } catch { /* already writable */ }
    rmSync(dir, { recursive: true, force: true })
  }
})

interface MutantOverrides {
  readonly from?: string
  readonly to?: string
  readonly expect?: readonly string[]
}

interface RunResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  readonly root: string
  readonly dirs: readonly string[]
}

function runHarness(options: { fault?: string; timeoutMs?: number; mutant?: MutantOverrides } = {}): RunResult {
  const root = mkdtempSync(resolve(tmpdir(), 'madar-mutation-evidence-'))
  scratches.push(root)
  mkdirSync(resolve(root, 'src'), { recursive: true })
  mkdirSync(resolve(root, 'tests/unit'), { recursive: true })
  writeFileSync(resolve(root, TARGET), PRISTINE)
  writeFileSync(resolve(root, SUITE), '// stand-in; the stub decides the verdict\n')
  writeFileSync(resolve(root, 'mutants.json'), JSON.stringify([{
    name: 'demo mutant',
    file: TARGET,
    test: SUITE,
    from: options.mutant?.from ?? "'ORIGINAL_VALUE'",
    to: options.mutant?.to ?? `'${MARKER}'`,
    expect: options.mutant?.expect ?? [TEST_NAME],
  }]))

  const child = spawnSync(process.execPath, [HARNESS, '--mutants', 'mutants.json'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      MADAR_MUTATION_VITEST_ARGV: JSON.stringify([process.execPath, STUB]),
      MADAR_MUTATION_SUITE_TIMEOUT_MS: String(options.timeoutMs ?? 300_000),
      MADAR_STUB_TARGET: TARGET,
      MADAR_STUB_MARKER: MARKER,
      MADAR_STUB_TEST_NAME: TEST_NAME,
      ...(options.fault === undefined ? {} : { MADAR_STUB_FAULT: options.fault }),
    },
  })

  const runs = resolve(root, 'node_modules/.cache/madar-mutations')
  const runIds = existsSync(runs) ? readdirSync(runs) : []
  expect(runIds).toHaveLength(1)
  const runRoot = resolve(runs, runIds[0] as string)
  return {
    status: child.status,
    stdout: child.stdout ?? '',
    stderr: child.stderr ?? '',
    root: runRoot,
    dirs: readdirSync(runRoot).sort(),
  }
}

const read = (run: RunResult, dir: string, file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(run.root, dir, file), 'utf8')) as Record<string, unknown>

const baselineDir = (run: RunResult): string => run.dirs.find((name) => name.includes('baseline')) as string
const mutantDir = (run: RunResult): string => run.dirs.find((name) => !name.includes('baseline')) as string

describe('mutation lifecycle evidence', () => {
  it('records a mutated digest that differs from the pre-mutation digest', () => {
    const run = runHarness()
    const restoration = read(run, mutantDir(run), 'restoration.json')
    const pre = (restoration['pre_mutation_digests'] as Record<string, string>)[TARGET]
    const mutated = (restoration['mutated_digests'] as Record<string, string>)[TARGET]

    expect(pre).toMatch(/^[0-9a-f]{64}$/)
    expect(mutated).toMatch(/^[0-9a-f]{64}$/)
    // The defect: reading the digest after restore() made these identical.
    expect(mutated).not.toBe(pre)
  })

  it('records a post-restoration digest equal to the pre-mutation digest', () => {
    const run = runHarness()
    const restoration = read(run, mutantDir(run), 'restoration.json')
    const pre = (restoration['pre_mutation_digests'] as Record<string, string>)[TARGET]
    const post = (restoration['post_restoration_digests'] as Record<string, string>)[TARGET]

    expect(post).toBe(pre)
    expect(restoration['restoration_succeeded']).toBe(true)
    expect(restoration['leftover_paths']).toEqual([])
  })

  it('gives a baseline an explicit not-applicable lifecycle rather than fabricated digests', () => {
    const run = runHarness()
    const restoration = read(run, baselineDir(run), 'restoration.json')

    expect(restoration['mutation_lifecycle']).toBe('not_applicable')
    expect(restoration['restoration_attempted']).toBe(false)
    expect(restoration['reason_code']).toBe('not_applicable_baseline')
    // Present and empty, not absent: an absent field cannot be distinguished
    // from one an audit forgot to write.
    expect(restoration['pre_mutation_digests']).toEqual({})
    expect(restoration['mutated_digests']).toEqual({})
    expect(restoration['post_restoration_digests']).toEqual({})
  })

  it('retains the child exit code for baseline and mutant alike', () => {
    const run = runHarness()
    const mutant = read(run, mutantDir(run), 'scoring.json')
    const baseline = read(run, baselineDir(run), 'scoring.json')

    // The reviewer found null here for every mutant and nothing at all for
    // baselines, while the children had plainly exited.
    expect((mutant['process_outcome'] as Record<string, unknown>)['exit_code']).toBe(1)
    expect((baseline['process_outcome'] as Record<string, unknown>)['exit_code']).toBe(0)
    expect((mutant['process_outcome'] as Record<string, unknown>)['child_started']).toBe(true)
  })

  it('retains the terminating signal when the child was killed rather than exiting', () => {
    const run = runHarness({ fault: 'signal' })
    const outcome = read(run, mutantDir(run), 'scoring.json')['process_outcome'] as Record<string, unknown>

    expect(outcome['termination_signal']).toBe('SIGKILL')
    expect(outcome['exit_code']).toBeNull()
    expect(outcome['timed_out']).toBe(false)
  })

  it('stamps one invocation identity into every artifact that can carry one', () => {
    const run = runHarness()
    const dir = mutantDir(run)
    const carriers = [
      'meta.json', 'command.json', 'suite-identity.json',
      'report-identity.json', 'scoring.json', 'restoration.json',
    ]
    const ids = new Set(carriers.map((file) => read(run, dir, file)['invocation_id']))

    expect(ids.size).toBe(1)
    const [only] = [...ids] as string[]
    expect(only).toMatch(/^[0-9a-z]+-[0-9a-z]+-m\d{3}$/)
    // Distinct from the baseline's: identity must name one invocation, not a
    // run and a guess at which directory it came from.
    expect(read(run, baselineDir(run), 'scoring.json')['invocation_id']).not.toBe(only)
  })

  it('writes scoring.json when the suite produced no report at all', () => {
    const run = runHarness({ fault: 'no-report' })
    const scoring = read(run, mutantDir(run), 'scoring.json')

    expect(scoring['classification']).toBe('infrastructure_failure')
    expect(scoring['classification']).not.toBe('caught')
    expect((scoring['process_outcome'] as Record<string, unknown>)['exit_code']).toBe(0)
  })

  it('writes scoring.json when the suite timed out', { timeout: 30_000 }, () => {
    const run = runHarness({ fault: 'hang', timeoutMs: 1_500 })
    const scoring = read(run, mutantDir(run), 'scoring.json')
    const outcome = scoring['process_outcome'] as Record<string, unknown>

    expect(scoring['classification']).toBe('infrastructure_failure')
    expect(outcome['timed_out']).toBe(true)
    expect(outcome['termination_signal']).toBe('SIGTERM')
  })

  it('writes scoring.json for a failure that happens before any suite runs', () => {
    // A stale anchor: the mutation cannot be applied, so the invocation is
    // abandoned. It previously `continue`d with its reason only on the
    // terminal -- the same place the first unexplained skip was lost.
    const run = runHarness({ mutant: { from: 'THIS ANCHOR IS NOT IN THE FILE' } })
    const scoring = read(run, mutantDir(run), 'scoring.json')

    expect(scoring['classification']).toBe('infrastructure_failure')
    expect(scoring['reason_code']).toBe('mutation_not_applied')
    expect((scoring['process_outcome'] as Record<string, unknown>)['child_started']).toBe(false)
    for (const file of ['meta.json', 'command.json', 'suite-identity.json', 'report-identity.json', 'restoration.json']) {
      expect(existsSync(resolve(run.root, mutantDir(run), file))).toBe(true)
    }
  })

  it('stops the matrix on a restoration failure and keeps the truthful digests', () => {
    const run = runHarness({ fault: 'chmod-readonly' })
    const restoration = read(run, mutantDir(run), 'restoration.json')
    const digests = {
      pre: (restoration['pre_mutation_digests'] as Record<string, string>)[TARGET],
      mutated: (restoration['mutated_digests'] as Record<string, string>)[TARGET],
      post: (restoration['post_restoration_digests'] as Record<string, string>)[TARGET],
    }

    expect(run.status).toBe(1)
    expect(run.stderr).toContain('RESTORATION FAILED')
    expect(restoration['restoration_succeeded']).toBe(false)
    expect(restoration['tree_clean_after']).toBe(false)
    expect(restoration['leftover_paths']).toEqual([TARGET])
    // Truthful, not tidy: the file really is still mutated, and the record
    // says so instead of reporting a restoration that did not happen.
    expect(digests.mutated).not.toBe(digests.pre)
    expect(digests.post).toBe(digests.mutated)
    expect(read(run, mutantDir(run), 'scoring.json')['reason_code']).toBe('restoration_failed')
  })
})
