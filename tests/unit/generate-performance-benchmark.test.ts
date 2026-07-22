import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

interface PerformanceHarness {
  nearestRank(values: number[], percentile: number): number
  summarizeTrials(samples: Array<Record<string, number | boolean | string>>): {
    count: number
    elapsed_ms: { min: number; max: number; p50: number; p95: number }
    parsed_files?: { min: number; max: number; p50: number; p95: number }
  }
  buildBaselineReceipt(input: Record<string, unknown>): Record<string, any>
  buildCandidateReceipt(input: Record<string, unknown>): Record<string, any>
  canonicalJson(value: unknown): string
  subjectIdentity(worktree: string, distRoot: string): Record<string, any>
}

const harnessPath = resolve('tools/eval/core-reset/incremental-performance.mjs')

async function loadHarness(): Promise<PerformanceHarness> {
  return await import(/* @vite-ignore */ pathToFileURL(harnessPath).href) as PerformanceHarness
}

function samples(
  elapsed: number,
  metrics: Partial<Record<'parsed_files' | 'reused_files' | 'invalidated_files' | 'dependency_closure_size', number>> = {},
  publicationAdvanced = true,
): Array<Record<string, number | boolean | string>> {
  return Array.from({ length: 20 }, (_, index) => ({
    ordinal: index + 1,
    elapsed_ms: elapsed + (index % 4),
    ...metrics,
    publication_advanced: publicationAdvanced,
  }))
}

const environment = {
  platform: 'test',
  release: 'test',
  architecture: 'test',
  node: 'v.test',
  cpu_model: 'test',
  cpu_count: 8,
  total_memory_bytes: 1,
  free_memory_bytes_at_start: 1,
  fingerprint: 'environment-fingerprint',
}

const protocol = {
  warmups: 3,
  trials: 20,
  clock: 'performance.now',
  percentile: 'nearest-rank',
  mutation_application_in_timed_window: false,
  persistent_warm_session: true,
  command: ['node', 'incremental-performance.mjs'],
  configuration: {},
}

const corpus = {
  kind: 'synthetic_fixture',
  id: 'synthetic-500-v1',
  commit: 'synthetic-500-v1',
  graph_root: '.',
  supported_files: 500,
  fingerprint: 'corpus-fingerprint',
}

function subject(headCommit: string, dirty = false): Record<string, unknown> {
  return {
    head_commit: headCommit,
    head_tree_oid: '1'.repeat(40),
    worktree_tree_oid: dirty ? '2'.repeat(40) : '1'.repeat(40),
    dirty,
    status_sha256: '3'.repeat(64),
    dist_fingerprint: '4'.repeat(64),
  }
}

describe('incremental performance evaluation harness', () => {
  it('uses deterministic nearest-rank p50/p95 and carries update counts', async () => {
    const harness = await loadHarness()
    const trialSamples = Array.from({ length: 20 }, (_, index) => ({
      elapsed_ms: index + 1,
      parsed_files: 1,
    }))

    expect(harness.nearestRank(trialSamples.map((sample) => sample.elapsed_ms), 50)).toBe(10)
    expect(harness.nearestRank(trialSamples.map((sample) => sample.elapsed_ms), 95)).toBe(19)
    expect(harness.summarizeTrials(trialSamples)).toMatchObject({
      count: 20,
      elapsed_ms: { min: 1, max: 20, p50: 10, p95: 19 },
      parsed_files: { min: 1, max: 1, p50: 1, p95: 1 },
    })
  })

  it('authenticates the exact dirty tree without mutating the real Git index', async () => {
    const harness = await loadHarness()
    const root = mkdtempSync(join(tmpdir(), 'madar-performance-identity-'))
    try {
      mkdirSync(join(root, 'dist'), { recursive: true })
      writeFileSync(join(root, '.gitignore'), 'dist/\n')
      writeFileSync(join(root, 'tracked.ts'), 'export const tracked = 1\n')
      writeFileSync(join(root, 'dist', 'subject.js'), 'export const subject = 1\n')
      execFileSync('git', ['init'], { cwd: root })
      execFileSync('git', ['config', 'user.email', 'madar@example.com'], { cwd: root })
      execFileSync('git', ['config', 'user.name', 'Madar Tests'], { cwd: root })
      execFileSync('git', ['add', '.'], { cwd: root })
      execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root })

      const clean = harness.subjectIdentity(root, join(root, 'dist'))
      writeFileSync(join(root, 'tracked.ts'), 'export const tracked = 2\n')
      writeFileSync(join(root, 'untracked.ts'), 'export const untracked = true\n')
      const dirty = harness.subjectIdentity(root, join(root, 'dist'))

      expect(clean).toMatchObject({ dirty: false })
      expect(clean.worktree_tree_oid).toBe(clean.head_tree_oid)
      expect(dirty).toMatchObject({
        head_commit: clean.head_commit,
        head_tree_oid: clean.head_tree_oid,
        dirty: true,
        dist_fingerprint: clean.dist_fingerprint,
      })
      expect(dirty.worktree_tree_oid).not.toBe(clean.worktree_tree_oid)
      expect(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' })).toBe('')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('grades a compatible protected-base receipt and hashes deterministic output', async () => {
    const harness = await loadHarness()
    const baseline = harness.buildBaselineReceipt({
      subject: subject('8886a0299ee30765ce149ca7ad5d1779496b78b5'),
      corpus,
      environment,
      protocol,
      samples: samples(100),
    })
    const input = {
      subject: subject('64c4d240f7561210a8170ea629b7692f3a7ed466', true),
      baseline,
      corpus,
      environment,
      protocol,
      samples: {
        clean_generation: samples(105),
        clean_index_stage: samples(80),
        cold_noop: samples(10, { parsed_files: 0, reused_files: 500, invalidated_files: 0, dependency_closure_size: 0 }, false),
        warm_noop: samples(5, { parsed_files: 0, reused_files: 500, invalidated_files: 0, dependency_closure_size: 0 }, false),
        warm_leaf_index_stage: samples(20, { parsed_files: 1, reused_files: 499, invalidated_files: 1, dependency_closure_size: 0 }, false),
        warm_leaf_refresh: samples(50, { parsed_files: 1, reused_files: 499, invalidated_files: 1, dependency_closure_size: 0 }),
      },
    }

    const first = harness.buildCandidateReceipt(input)
    const second = harness.buildCandidateReceipt(structuredClone(input))

    expect(first).toEqual(second)
    expect(harness.canonicalJson(first)).toBe(harness.canonicalJson(second))
    expect(first.receipt_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(first.eligible_for_acceptance).toBe(true)
    expect(first.protocol).toMatchObject({ warmups: 3, trials: 20, persistent_warm_session: true })
    expect(first.measurements.warm_leaf_refresh).toMatchObject({
      count: 20,
      parsed_files: { min: 1, max: 1 },
      reused_files: { min: 499, max: 499 },
    })
    expect(first.gates).toMatchObject({
      sample_protocol: { pass: true },
      corpus_eligibility: { kind: 'synthetic_fixture', pass: true },
      cold_noop_p50_ratio: { pass: true },
      warm_noop_zero_parse: { pass: true },
      warm_private_leaf_scope: { pass: true },
      warm_index_p50_ratio: { pass: true },
      warm_refresh_p50_ratio: { pass: true },
      warm_refresh_p95_ratio: { pass: true },
      clean_generation_regression: { baseline_compatible: true, pass: true },
    })
  })

  it('fails closed for an incompatible baseline or an undersized corpus', async () => {
    const harness = await loadHarness()
    const baseline = harness.buildBaselineReceipt({
      subject: subject('0'.repeat(40)),
      corpus,
      environment,
      protocol,
      samples: samples(100),
    })
    const receipt = harness.buildCandidateReceipt({
      subject: subject('64c4d240f7561210a8170ea629b7692f3a7ed466', true),
      baseline,
      corpus: { ...corpus, supported_files: 499 },
      environment,
      protocol,
      samples: {
        clean_generation: samples(100),
        clean_index_stage: samples(80),
        cold_noop: samples(10, { parsed_files: 0, reused_files: 499, invalidated_files: 0, dependency_closure_size: 0 }, false),
        warm_noop: samples(5, { parsed_files: 0, reused_files: 499, invalidated_files: 0, dependency_closure_size: 0 }, false),
        warm_leaf_index_stage: samples(20, { parsed_files: 1, reused_files: 498, invalidated_files: 1, dependency_closure_size: 0 }, false),
        warm_leaf_refresh: samples(50, { parsed_files: 1, reused_files: 498, invalidated_files: 1, dependency_closure_size: 0 }),
      },
    })

    expect(receipt.eligible_for_acceptance).toBe(false)
    expect(receipt.gates.corpus_eligibility.pass).toBe(false)
    expect(receipt.gates.clean_generation_regression).toMatchObject({
      baseline_compatible: false,
      ratio: null,
      pass: false,
    })
  })

  it('accepts a pinned non-empty held-out corpus without applying the synthetic 500-file minimum', async () => {
    const harness = await loadHarness()
    const heldOut = {
      ...corpus,
      kind: 'held_out_repository',
      id: 'held-out:openstatus:apps/status-page',
      commit: '295e5a72f52c172d326aa950e81043e72a4f20c0',
      graph_root: 'apps/status-page',
      supported_files: 227,
    }
    const baseline = harness.buildBaselineReceipt({
      subject: subject('8886a0299ee30765ce149ca7ad5d1779496b78b5'),
      corpus: heldOut,
      environment,
      protocol,
      samples: samples(100),
    })
    const receipt = harness.buildCandidateReceipt({
      subject: subject('64c4d240f7561210a8170ea629b7692f3a7ed466', true),
      baseline,
      corpus: heldOut,
      environment,
      protocol,
      samples: {
        clean_generation: samples(100),
        clean_index_stage: samples(80),
        cold_noop: samples(10, { parsed_files: 0, reused_files: 227, invalidated_files: 0, dependency_closure_size: 0 }, false),
        warm_noop: samples(5, { parsed_files: 0, reused_files: 227, invalidated_files: 0, dependency_closure_size: 0 }, false),
        warm_leaf_index_stage: samples(20, { parsed_files: 1, reused_files: 226, invalidated_files: 1, dependency_closure_size: 0 }, false),
        warm_leaf_refresh: samples(50, { parsed_files: 1, reused_files: 226, invalidated_files: 1, dependency_closure_size: 0 }),
      },
    })

    expect(receipt.gates.corpus_eligibility).toMatchObject({
      kind: 'held_out_repository',
      supported_files: 227,
      pass: true,
    })
    expect(receipt.eligible_for_acceptance).toBe(true)
  })

  it('enforces three warmups and twenty trials before loading a subject build', () => {
    expect(() => execFileSync(process.execPath, [harnessPath, '--warmups', '2'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })).toThrow(/--warmups must be at least 3/)
    expect(() => execFileSync(process.execPath, [harnessPath, '--trials', '19'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })).toThrow(/--trials must be at least 20/)
  })

  it('keeps the evaluator outside production and retains one warm session in the measured path', () => {
    const source = readFileSync(harnessPath, 'utf8')
    expect(source).toContain('const updateSession = subject.createUpdateSession(root, warmSeed)')
    expect(source).toContain('updateSession.update({})')
    expect(source).toContain("receipt_kind: 'core-reset-incremental-performance'")
    expect(source).not.toContain("from '../../../src/")
  })
})
