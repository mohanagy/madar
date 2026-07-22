import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

// Development-only JavaScript is deliberately outside the production TypeScript build.
// @ts-expect-error -- the isolated evaluator does not ship declarations in the npm package
import { productionSourceDelta, sourceInventory } from '../../tools/eval/core-reset/record-baseline.mjs'

const read = (path: string): string => readFileSync(resolve(path), 'utf8')
const git = process.platform === 'win32' ? 'git.exe' : 'git'
const INCREMENTAL_BASE = '8886a0299ee30765ce149ca7ad5d1779496b78b5'
const INCREMENTAL_IMPLEMENTATION = '151f08ed1ca4db4f15dbe96d87f03d7226d4f3e2'
const STOPPED_INCREMENTAL_CANDIDATE = '1d3c9b6d264a5c76d212b93da7c63718cbe49b3d'
const STOPPED_INCREMENTAL_TREE = '6bd1ae5762afaa868d5cf6ce165b061aa290bfda'
const INCREMENTAL_PREDECESSORS = [
  'src/infrastructure/generate.ts',
  'src/contracts/generation-policy.ts',
  'src/infrastructure/generation-policy.ts',
  'src/contracts/indexing.ts',
  'src/pipeline/indexing-generation.ts',
  'src/pipeline/indexing-outcomes.ts',
  'src/infrastructure/indexing-manifest.ts',
  'src/pipeline/detect.ts',
  'src/pipeline/manifest.ts',
  'src/infrastructure/refresh-lease.ts',
  'src/contracts/watcher-state.ts',
  'src/infrastructure/watcher-state.ts',
  'src/infrastructure/watch.ts',
  'src/infrastructure/background-auto-refresh.ts',
  'src/shared/graph-build-freshness.ts',
] as const
const INCREMENTAL_TRANSFERS = {
  'src/core/pipeline/stage.ts': 'evidence-path-query',
  'src/runtime/freshness.ts': 'evidence-path-query',
  'src/shared/source-discovery.ts': 'evidence-path-query',
  'src/infrastructure/doctor.ts': 'thin-delivery',
} as const
const INCREMENTAL_REPLACEMENTS = [
  'src/application/generate-index.ts',
  'src/application/update-index.ts',
  'src/domain/index/build-state.ts',
  'src/adapters/filesystem/source-catalog.ts',
  'src/adapters/filesystem/index-store.ts',
  'src/infrastructure/watch-index.ts',
] as const
const INCREMENTAL_OWNED_REPLACEMENTS = INCREMENTAL_REPLACEMENTS.filter(
  (path) => path !== 'src/domain/index/build-state.ts',
)

function productionTypeScriptFiles(directory = 'src'): string[] {
  return readdirSync(resolve(directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return productionTypeScriptFiles(path)
    return entry.isFile() && path.endsWith('.ts') ? [path] : []
  })
}

const manifestGlob = (pattern: string): RegExp => {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', '\u0000')
    .replaceAll('*', '[^/]*')
    .replaceAll('\u0000', '.*')
  return new RegExp(`^${escaped}$`)
}

function deletedProductionFiles(commit: string): string[] {
  const output = execFileSync(
    git,
    ['diff-tree', '--no-commit-id', '--name-only', '--diff-filter=D', '-r', `${commit}^`, commit, '--', 'src'],
    { encoding: 'utf8' },
  )
  return output.split('\n').filter((path) => path.endsWith('.ts'))
}

function productionTypeScriptFilesAtCommit(commit: string): string[] {
  const output = execFileSync(git, ['ls-tree', '-r', '--name-only', commit, '--', 'src'], { encoding: 'utf8' })
  return output.split('\n').filter((path) => path.endsWith('.ts'))
}

function logicalLocAtCommit(commit: string, paths: readonly string[]): number {
  return paths.reduce((total, path) => {
    const source = execFileSync(git, ['show', `${commit}:${path}`], { encoding: 'utf8' })
    const lineFeeds = source.match(/\n/g)?.length ?? 0
    return total + lineFeeds + (source.length > 0 && !source.endsWith('\n') ? 1 : 0)
  }, 0)
}

describe('core reset governance', () => {
  it('keeps one linked roadmap and RFC contract', () => {
    const roadmap = read('docs/roadmap.md')
    const design = read('docs/designs/2026-07-19-core-reset.md')
    const scorecard = read('docs/core-reset/scorecard.md')
    const readme = read('README.md')
    const contributing = read('CONTRIBUTING.md')

    expect(roadmap).toContain('# Public roadmap')
    expect(roadmap).toContain('issues/577')
    expect(roadmap).toContain('milestone/7')
    expect(roadmap).toContain('projects/8')
    expect(roadmap).toContain('removal-manifest.yml')
    expect(roadmap).toContain('scorecard.md')
    expect(roadmap).toContain('## Passed — directed multigraph')
    expect(roadmap).toContain('## Passed — canonical TypeScript/JavaScript index')
    expect(roadmap).toContain('## Passed — delete legacy extraction and non-code/other-language ingestion')
    expect(roadmap).toContain('## In progress — generation and incremental index')
    expect(roadmap).toContain('issues/592')
    expect(roadmap).toContain('issues/588')
    expect(roadmap).not.toContain('## Ready — generation and incremental index')
    expect(roadmap).not.toContain('No phase is In progress')
    expect(roadmap).not.toContain('## In progress — canonical TypeScript/JavaScript index')
    expect(roadmap).not.toContain('## In progress — delete legacy extraction and non-code/other-language ingestion')
    expect(roadmap).toContain('## Next')
    expect(roadmap).toContain('## Later')
    expect(roadmap).toContain('accepted Core Reset')
    expect(roadmap).not.toContain('currently **proposed**')
    expect(roadmap).not.toMatch(/^##\s+v?\d+(?:\.\d+)+\b/im)
    expect(roadmap).not.toMatch(/^##\s+Features?\b/im)

    expect(design).toContain('issues/577')
    expect(design).toContain('**Status:** accepted')
    expect(design).toContain('not a permanent V1/V2 split')
    expect(design).toContain('Merging code alone is not completion')
    expect(design).toContain('issues/592')
    expect(design).toContain('No in-memory or disk session cache survives')
    expect(design).toContain('`graph.json` is the sole authoritative index artifact and atomic commit marker')
    expect(design).toContain('three warm-ups and 20 measured trials')
    expect(design).toContain('clean generation may regress by at most 10%')
    expect(design).toContain('Held-out timing was intentionally skipped')
    expect(design).toContain('The failed incremental path was deleted')
    expect(design).toContain('Only successfully indexed `.ts`, `.tsx`, `.js`, and `.jsx` inputs determine supported-index completeness')
    expect(design).toContain('There is no generation directory, persistent fact cache, versioned snapshot store')
    expect(scorecard).toContain('**Status:** accepted')
    expect(scorecard).toContain('| Directed multigraph | **Passed**')
    expect(scorecard).toContain('| Canonical TypeScript index | **Passed**')
    expect(scorecard).toContain('| Legacy extraction plus non-code/other-language ingestion | **Passed**')
    expect(scorecard).toContain('| Generation and reconciliation | **In progress**')
    expect(scorecard).toContain('single In progress phase through #592')
    expect(scorecard).toContain('clean generation may regress at most 10%')
    expect(scorecard).toContain('recognized unsupported files and expected policy exclusions are informational')
    expect(scorecard).toContain('The fixed 500-file experiment stopped the incremental design')
    expect(scorecard).toContain('There is no in-memory or disk session cache')
    expect(scorecard).not.toContain('Ready — not In progress')
    expect(scorecard).not.toContain('No phase is In progress')
    expect(scorecard).toContain('final CodeRabbit rerun was rate-limited')
    expect(scorecard).toContain('owner-approved exception')
    expect(scorecard).not.toContain('CI and review remain pending')
    expect(readme).toContain('docs/roadmap.md')
    expect(contributing).toContain('docs/roadmap.md')
    expect(contributing).toContain('The accepted Core Reset')
    expect(contributing).not.toContain('The proposed Core Reset')
  })

  it('keeps the removal manifest machine-readable and explicit', () => {
    const manifestPath = 'docs/core-reset/removal-manifest.yml'
    expect(existsSync(resolve(manifestPath))).toBe(true)

    const manifest = parse(read(manifestPath)) as {
      schema_version: number
      status: string
      rules: string[]
      current: {
        updated_at: string
        completed_phase: string
        active_phase: string | null
        ready_phase: string | null
        base_commit: string
        completed_phase_commit: string
        implementation_commit: string
        production_typescript_files: number
        production_typescript_loc: number
        production_loc_added: number
        production_loc_removed: number
        production_loc_net: number
        npm_files: number
        npm_packed_bytes: number
        npm_unpacked_bytes: number
      }
      items: Array<{
        id: string
        disposition: string
        status: string
        notes?: string
        absorbs?: string[]
        absorbed_by?: string
        transferred_sources?: string[]
        replacement_sources?: string[]
        preserve?: string[]
        production_file_budget?: { added_max: number; removed_min: number }
        production_loc_budget?: { added_max: number; removed_min: number; net_max: number }
        runtime_dependency_budget?: { added_max: number; removed_min: number }
        development_dependency_budget?: { added_max: number; removed_min: number }
        final_source_budget?: { files_max: number; loc_max: number }
        npm_package_budget?: { files_max: number; unpacked_bytes_max: number; packed_bytes_delta_max: number }
        performance_budget?: {
          cold_noop_median_ratio_max: number
          clean_generation_regression_ratio_max: number
          measured_trials_min: number
        }
        stopped_incremental_gate?: {
          candidate_checkpoint: string
          candidate_worktree_tree: string
          fixed_fixture_supported_files: number
          warm_index_p50_ratio: number
          warm_refresh_p50_ratio: number
          warm_refresh_p95_ratio: number
          heldout: string
          failed_path: string
        }
        completeness_contract?: {
          supported_extensions: string[]
          supported_success_determines_completeness: boolean
          supported_failure: string
          recognized_unsupported: string
          expected_policy_exclusions: string
          safety_exclusions: string
        }
        equivalence_mutations?: string[]
        publication_contract?: {
          authoritative_artifact: string
          commit_marker: string
          derived_diagnostics_non_blocking: boolean
          persistent_fact_cache: string
          versioned_snapshot_store: string
        }
        activation?: {
          issue: string
          owner_approval: string
          rfc_amendment: string
          protected_base: string
        }
        implementation?: {
          commit: string
          mode: string
          in_memory_session_cache: string
          disk_session_cache: string
          failed_incremental_path: string
          evidence_receipts: string[]
        }
        runtime_dependencies_removed?: string[]
        retired_cli_flags?: string[]
        completion?: {
          issue: string
          pull_request: string
          commit: string
          production_files_added?: number
          production_files_removed?: number
          production_typescript_files: number
          production_typescript_loc: number
          production_loc_added: number
          production_loc_removed: number
          production_loc_net: number
          dependencies_added: number
          dependencies_removed?: number
          npm_files?: number
          npm_packed_bytes?: number
          npm_unpacked_bytes?: number
          ci_matrix_jobs_passed: number
          ci_run?: string
          coderabbit: string
          coderabbit_findings_addressed?: number
          coderabbit_findings_confirmed?: number
          coderabbit_review_body_nitpicks_addressed?: number
          independent_review?: string
          independent_review_receipt?: string
          unresolved_review_threads: number
        }
        sources?: string[]
        removed_sources?: string[]
        exit_gate: string
        remove_when?: string
      }>
    }

    expect(manifest.schema_version).toBe(1)
    expect(manifest.status).toBe('accepted')
    expect(manifest.current).toMatchObject({
      updated_at: '2026-07-22',
      completed_phase: 'legacy-extraction',
      active_phase: 'generation-and-incremental',
      ready_phase: null,
      base_commit: INCREMENTAL_BASE,
      completed_phase_commit: 'd46031eed7b0cf2d8bb7b7b6267a51322d9e2490',
      implementation_commit: INCREMENTAL_IMPLEMENTATION,
      production_typescript_files: 130,
      production_typescript_loc: 66_418,
      production_loc_added: 2_189,
      production_loc_removed: 4_725,
      production_loc_net: -2_536,
      npm_files: 276,
      npm_packed_bytes: 572_142,
      npm_unpacked_bytes: 2_699_814,
    })
    expect(manifest.rules.length).toBeGreaterThan(0)
    expect(manifest.items.length).toBeGreaterThan(10)

    const ids = manifest.items.map((item) => item.id.trim())
    expect(new Set(ids).size).toBe(ids.length)

    for (const item of manifest.items) {
      expect(item.id.trim().length).toBeGreaterThan(0)
      expect(['keep', 'rebuild', 'move', 'delete', 'defer']).toContain(item.disposition)
      expect(['proposed', 'planned', 'in_progress', 'complete', 'approved_exception']).toContain(item.status)
      expect(item.exit_gate.trim().length).toBeGreaterThan(0)
      for (const source of item.sources ?? []) {
        expect(source.trim()).toMatch(/^(?:\.github|docs|examples|src|tests|tools)\//)
      }
      for (const source of item.removed_sources ?? []) {
        expect(source.trim()).toMatch(/^(?:\.github|docs|examples|src|tests|tools)\//)
      }
      if (item.disposition === 'rebuild') {
        expect(item.remove_when?.trim().length).toBeGreaterThan(0)
      }
    }
    const directed = manifest.items.find((item) => item.id === 'directed-multigraph')
    expect(directed?.status).toBe('complete')
    expect(directed?.notes).toContain('#582')
    expect(directed?.completion).toEqual({
      issue: 'https://github.com/mohanagy/madar/issues/582',
      pull_request: 'https://github.com/mohanagy/madar/pull/583',
      commit: '63c59049178e82bd6bd1c928f6666ef159365bbe',
      production_typescript_files: 178,
      production_typescript_loc: 93_792,
      production_loc_added: 1_197,
      production_loc_removed: 4_171,
      production_loc_net: -2_974,
      dependencies_added: 0,
      ci_matrix_jobs_passed: 6,
      coderabbit: 'passed',
      unresolved_review_threads: 0,
    })
    const canonical = manifest.items.find((item) => item.id === 'canonical-typescript-index')
    expect(canonical?.status).toBe('complete')
    expect(canonical?.notes).toContain('#585')
    expect(canonical?.notes).toContain('explicit owner exception')
    expect(canonical?.completion).toEqual({
      issue: 'https://github.com/mohanagy/madar/issues/585',
      pull_request: 'https://github.com/mohanagy/madar/pull/586',
      commit: '4dfd48194f2fab00b2cd2271a6f7917909dde9d4',
      production_typescript_files: 170,
      production_typescript_loc: 91_539,
      production_loc_added: 5_538,
      production_loc_removed: 7_791,
      production_loc_net: -2_253,
      dependencies_added: 0,
      ci_matrix_jobs_passed: 6,
      coderabbit: 'rate_limited_owner_exception',
      coderabbit_findings_addressed: 9,
      coderabbit_findings_confirmed: 8,
      coderabbit_review_body_nitpicks_addressed: 2,
      independent_review: 'passed',
      independent_review_receipt: 'https://github.com/mohanagy/madar/pull/586#issuecomment-5036311350',
      unresolved_review_threads: 0,
    })
    const legacy = manifest.items.find((item) => item.id === 'legacy-extraction')
    const nonCode = manifest.items.find((item) => item.id === 'non-code-and-other-language-ingest')
    expect(legacy).toMatchObject({
      status: 'complete',
      absorbs: ['non-code-and-other-language-ingest'],
      production_file_budget: { added_max: 1, removed_min: 31 },
      production_loc_budget: { added_max: 900, removed_min: 20_951, net_max: -20_000 },
      runtime_dependency_budget: { added_max: 0, removed_min: 3 },
      runtime_dependencies_removed: ['@vscode/tree-sitter-wasm', 'web-tree-sitter', 'fflate'],
      retired_cli_flags: ['--legacy', '--spi', '--include-docs', '--docs', '--wiki'],
    })
    expect(legacy?.notes).toContain('CodeRabbit skipped the actual review')
    expect(legacy?.completion).toEqual({
      issue: 'https://github.com/mohanagy/madar/issues/588',
      pull_request: 'https://github.com/mohanagy/madar/pull/590',
      commit: 'd46031eed7b0cf2d8bb7b7b6267a51322d9e2490',
      production_files_added: 0,
      production_files_removed: 31,
      production_typescript_files: 139,
      production_typescript_loc: 68_954,
      production_loc_added: 815,
      production_loc_removed: 23_400,
      production_loc_net: -22_585,
      dependencies_added: 0,
      dependencies_removed: 3,
      npm_files: 314,
      npm_packed_bytes: 592_783,
      npm_unpacked_bytes: 2_794_076,
      ci_matrix_jobs_passed: 6,
      ci_run: 'https://github.com/mohanagy/madar/actions/runs/29899357806',
      coderabbit: 'skipped_base_owner_exception',
      independent_review: 'passed',
      independent_review_receipt: 'https://github.com/mohanagy/madar/pull/590#issuecomment-5043069972',
      unresolved_review_threads: 0,
    })
    expect(legacy?.transferred_sources).toEqual([
      'src/application/build-graph.ts',
      'src/core/provenance/ingest.ts',
      'src/infrastructure/cache.ts',
      'src/infrastructure/capabilities.ts',
    ])
    expect(nonCode).toMatchObject({ status: 'complete', absorbed_by: 'legacy-extraction' })
    const deletionOwners = [legacy, ...(legacy?.absorbs ?? []).map((id) => manifest.items.find((item) => item.id === id))]
    expect(deletionOwners.every(Boolean)).toBe(true)
    const legacyBase = `${legacy!.completion!.commit}^`
    const baseFiles = productionTypeScriptFilesAtCommit(legacyBase)
    const deletionFiles = baseFiles.filter((file) =>
      deletionOwners.some((item) => (item?.removed_sources ?? []).some((pattern) => manifestGlob(pattern).test(file))),
    )
    expect(new Set(deletionFiles).size).toBe(31)
    expect(logicalLocAtCommit(legacyBase, deletionFiles)).toBe(20_951)
    const generation = manifest.items.find((item) => item.id === 'generation-and-incremental')
    expect(manifest.items.filter((item) => item.status === 'in_progress').map((item) => item.id)).toEqual([
      'generation-and-incremental',
    ])
    expect(generation).toMatchObject({
      status: 'in_progress',
      sources: INCREMENTAL_OWNED_REPLACEMENTS,
      removed_sources: [...INCREMENTAL_PREDECESSORS],
      transferred_sources: Object.keys(INCREMENTAL_TRANSFERS),
      replacement_sources: [...INCREMENTAL_REPLACEMENTS],
      production_file_budget: { added_max: 6, removed_min: 15 },
      production_loc_budget: { added_max: 2_200, removed_min: 3_839, net_max: -1_500 },
      runtime_dependency_budget: { added_max: 0, removed_min: 0 },
      development_dependency_budget: { added_max: 0, removed_min: 0 },
      final_source_budget: { files_max: 130, loc_max: 67_454 },
      npm_package_budget: { files_max: 296, unpacked_bytes_max: 2_700_000, packed_bytes_delta_max: 0 },
      performance_budget: {
        cold_noop_median_ratio_max: 0.20,
        clean_generation_regression_ratio_max: 0.10,
        measured_trials_min: 20,
      },
      stopped_incremental_gate: {
        candidate_checkpoint: STOPPED_INCREMENTAL_CANDIDATE,
        candidate_worktree_tree: STOPPED_INCREMENTAL_TREE,
        fixed_fixture_supported_files: 500,
        warm_index_p50_ratio: 0.824,
        warm_refresh_p50_ratio: 1.047,
        warm_refresh_p95_ratio: 1.029,
        heldout: 'intentionally_skipped_after_fixed_gate_stop',
        failed_path: 'deleted',
      },
      completeness_contract: {
        supported_extensions: ['.ts', '.tsx', '.js', '.jsx'],
        supported_success_determines_completeness: true,
        supported_failure: 'incomplete_with_exact_file_and_reason',
        recognized_unsupported: 'informational',
        expected_policy_exclusions: 'informational',
        safety_exclusions: 'separate_and_never_indexed',
      },
      equivalence_mutations: [
        'no_op',
        'add',
        'private_leaf_change',
        'exported_signature_change',
        'delete',
        'rename',
        'compiler_control',
        'madarignore',
        'gitignore',
        'recognized_unsupported_add_delete_rename',
        'allowed_and_rejected_symlink',
        'linked_worktree',
      ],
      publication_contract: {
        authoritative_artifact: 'graph.json',
        commit_marker: 'graph.json',
        derived_diagnostics_non_blocking: true,
        persistent_fact_cache: 'forbidden',
        versioned_snapshot_store: 'forbidden',
      },
      activation: {
        issue: 'https://github.com/mohanagy/madar/issues/592',
        owner_approval: 'https://github.com/mohanagy/madar/issues/592#issuecomment-5044052506',
        rfc_amendment: 'https://github.com/mohanagy/madar/issues/577#issuecomment-5044052586',
        protected_base: INCREMENTAL_BASE,
      },
      implementation: {
        commit: INCREMENTAL_IMPLEMENTATION,
        mode: 'cold_noop_or_full_canonical_reconcile',
        in_memory_session_cache: 'absent',
        disk_session_cache: 'absent',
        failed_incremental_path: 'deleted',
        evidence_receipts: [
          'docs/core-reset/evidence/generation-incremental-protected-base-500.json',
          'docs/core-reset/evidence/generation-incremental-stop-500.json',
          'docs/core-reset/evidence/generation-full-reconcile-500.json',
          'docs/core-reset/evidence/generation-incremental-inventory.json',
        ],
      },
    })
    const incrementalBaseFiles = productionTypeScriptFilesAtCommit(INCREMENTAL_BASE)
    expect(INCREMENTAL_PREDECESSORS.every((path) => incrementalBaseFiles.includes(path))).toBe(true)
    expect(INCREMENTAL_PREDECESSORS.every((path) => !existsSync(resolve(path)))).toBe(true)
    expect(INCREMENTAL_REPLACEMENTS.every((path) => existsSync(resolve(path)))).toBe(true)
    expect(logicalLocAtCommit(INCREMENTAL_BASE, INCREMENTAL_PREDECESSORS)).toBe(3_839)
    for (const id of ['evidence-path-query', 'thin-delivery']) {
      expect(manifest.items.find((item) => item.id === id)?.status).toBe('proposed')
    }
  })

  it('measures logical LOC independently from checkout line endings', () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-core-reset-loc-'))
    try {
      mkdirSync(join(root, 'src'), { recursive: true })
      writeFileSync(join(root, 'src', 'tracked.ts'), 'export const one = 1\nexport const two = 2\n')
      execFileSync(git, ['init', '-b', 'main'], { cwd: root })
      execFileSync(git, ['config', 'core.autocrlf', 'false'], { cwd: root })
      execFileSync(git, ['config', 'user.email', 'madar-core-reset@example.invalid'], { cwd: root })
      execFileSync(git, ['config', 'user.name', 'Madar Core Reset'], { cwd: root })
      execFileSync(git, ['add', '.'], { cwd: root })
      execFileSync(git, ['commit', '-m', 'baseline'], { cwd: root })
      const baseline = execFileSync(git, ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()

      writeFileSync(join(root, 'src', 'tracked.ts'), 'export const one = 1\r\nexport const two = 3\r\n')
      writeFileSync(join(root, 'src', 'untracked.ts'), 'export const added = true\r\n')

      expect(productionSourceDelta(baseline, root)).toEqual({ added: 2, removed: 1, net: 1 })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('measures the current source inventory and phase delta from the recorded protected base', () => {
    const manifest = parse(read('docs/core-reset/removal-manifest.yml')) as {
      current: {
        completed_phase: string
        active_phase: string | null
        base_commit: string
        implementation_commit: string
        production_typescript_files: number
        production_typescript_loc: number
        production_loc_added: number
        production_loc_removed: number
        production_loc_net: number
        npm_files: number
        npm_packed_bytes: number
        npm_unpacked_bytes: number
      }
      items: Array<{
        id: string
        status: string
        production_loc_budget?: { added_max: number; removed_min: number; net_max: number }
      }>
    }
    const { current } = manifest
    expect(execFileSync(git, ['cat-file', '-t', `${current.base_commit}^{commit}`], { encoding: 'utf8' }).trim()).toBe('commit')
    expect(() => execFileSync(git, ['merge-base', '--is-ancestor', current.base_commit, 'HEAD'])).not.toThrow()

    const inventory = sourceInventory()
    const delta = productionSourceDelta(current.base_commit)
    const phase = manifest.items.find((item) => item.id === (current.active_phase ?? current.completed_phase))
    const budget = phase?.production_loc_budget
    expect(budget).toBeDefined()
    expect(inventory.filesystemViolations).toEqual([])
    expect(delta.added).toBeLessThanOrEqual(budget!.added_max)
    const isActivationOnly = current.active_phase !== null
      && phase?.status === 'in_progress'
      && delta.added === 0
      && delta.removed === 0
      && delta.net === 0
    const meetsExitBudget = delta.removed >= budget!.removed_min && delta.net <= budget!.net_max
    expect(isActivationOnly || meetsExitBudget).toBe(true)
    expect({
      production_typescript_files: inventory.files,
      production_typescript_loc: inventory.loc,
      production_loc_added: delta.added,
      production_loc_removed: delta.removed,
      production_loc_net: delta.net,
    }).toEqual({
      production_typescript_files: current.production_typescript_files,
      production_typescript_loc: current.production_typescript_loc,
      production_loc_added: current.production_loc_added,
      production_loc_removed: current.production_loc_removed,
      production_loc_net: current.production_loc_net,
    })
    expect(current).toMatchObject({
      implementation_commit: INCREMENTAL_IMPLEMENTATION,
      npm_files: 276,
      npm_packed_bytes: 572_142,
      npm_unpacked_bytes: 2_699_814,
    })
  })

  it('records the simplified implementation without retaining the failed warm path', () => {
    expect(productionSourceDelta(INCREMENTAL_BASE)).toEqual({ added: 2_189, removed: 4_725, net: -2_536 })
    expect(execFileSync(git, ['cat-file', '-t', `${INCREMENTAL_IMPLEMENTATION}^{commit}`], { encoding: 'utf8' }).trim())
      .toBe('commit')
    const sourceDrift = execFileSync(
      git,
      ['diff', '--name-only', INCREMENTAL_IMPLEMENTATION, '--', 'src', 'package.json', 'package-lock.json'],
      { encoding: 'utf8' },
    ).trim()
    expect(sourceDrift).toBe('')
    for (const predecessor of INCREMENTAL_PREDECESSORS) {
      expect(existsSync(resolve(predecessor)), `${predecessor} must be deleted`).toBe(false)
    }
    for (const replacement of INCREMENTAL_REPLACEMENTS) {
      expect(existsSync(resolve(replacement)), `${replacement} must exist`).toBe(true)
    }

    const production = productionTypeScriptFiles().map((path) => read(path)).join('\n')
    for (const rejectedApi of [
      'warm_incremental',
      'CanonicalTypeScriptIndexSession',
      'createCanonicalTypeScriptIndexSession',
      'createUpdateIndexSession',
      'persistentWarmSession',
      'indexSession',
    ]) {
      expect(production, `${rejectedApi} must not survive in production`).not.toContain(rejectedApi)
    }

    const stop = JSON.parse(read('docs/core-reset/evidence/generation-incremental-stop-500.json')) as {
      measured_candidate_commit: string
      eligible_for_acceptance: boolean
      subject: { worktree_tree_oid: string }
      gates: {
        warm_index_p50_ratio: { actual: number; pass: boolean }
        warm_refresh_p50_ratio: { actual: number; pass: boolean }
        warm_refresh_p95_ratio: { actual: number; pass: boolean }
      }
      stop_condition: { triggered: boolean; held_out: { status: string } }
    }
    expect(stop).toMatchObject({
      measured_candidate_commit: STOPPED_INCREMENTAL_CANDIDATE,
      eligible_for_acceptance: false,
      subject: { worktree_tree_oid: STOPPED_INCREMENTAL_TREE },
      gates: {
        warm_index_p50_ratio: { actual: 0.824, pass: false },
        warm_refresh_p50_ratio: { actual: 1.047, pass: false },
        warm_refresh_p95_ratio: { actual: 1.029, pass: false },
      },
      stop_condition: { triggered: true, held_out: { status: 'intentionally_skipped' } },
    })

    const receipt = JSON.parse(read('docs/core-reset/evidence/generation-incremental-inventory.json')) as unknown
    expect(receipt).toEqual({
      schema_version: 1,
      issue: 'https://github.com/mohanagy/madar/issues/592',
      protected_base: INCREMENTAL_BASE,
      implementation_commit: INCREMENTAL_IMPLEMENTATION,
      production: {
        typescript_files: 130,
        typescript_loc: 66_418,
        loc_added: 2_189,
        loc_removed: 4_725,
        loc_net: -2_536,
        predecessor_files_removed: 15,
        predecessor_loc_removed: 3_839,
        replacement_files: 6,
        replacement_loc: 1_484,
        runtime_dependencies_added: 0,
        development_dependencies_added: 0,
      },
      package: {
        command: 'npm pack --dry-run --json',
        name: '@lubab/madar',
        version: '0.32.0',
        files: 276,
        packed_bytes: 572_142,
        unpacked_bytes: 2_699_814,
        shasum: '78957a04db589c8555100ea3c461b94ca3adc510',
        integrity: 'sha512-0k2QI/KUN9Bmfk/47bVl0sabxPhvOrfiR17/ZELpVPiBe0hnv8OD3sX8sY5/m+0MCiROlOBROYuLcPXEPEILwg==',
      },
      budgets: {
        production_files_pass: true,
        production_loc_pass: true,
        production_delta_pass: true,
        replacement_surface_pass: true,
        package_files_pass: true,
        package_unpacked_bytes_pass: true,
        package_packed_bytes_pass: true,
        dependency_additions_pass: true,
      },
    })

    const shipping = JSON.parse(read('docs/core-reset/evidence/generation-full-reconcile-500.json')) as {
      eligible_for_acceptance: boolean
      receipt_sha256: string
      subject: { head_commit: string; dirty: boolean; head_tree_oid: string; worktree_tree_oid: string }
      environment: { node: string }
      protocol: { warmups: number; trials: number; persistent_warm_session: boolean; shipping_path: string }
      gates: {
        subject_identity: { pass: boolean }
        sample_protocol: { pass: boolean }
        corpus_eligibility: { pass: boolean }
        cold_noop_p50_ratio: { actual: number; pass: boolean }
        cold_noop_zero_parse: { pass: boolean }
        clean_generation_regression: { baseline_compatible: boolean; ratio: number; pass: boolean }
      }
    }
    expect(shipping).toMatchObject({
      eligible_for_acceptance: true,
      receipt_sha256: 'a2a46f9580478dc7318f1e064d60d5de874657b7758f8e7fb12f26793b468f38',
      subject: {
        head_commit: INCREMENTAL_IMPLEMENTATION,
        dirty: false,
        head_tree_oid: 'b76855f51f08f8884423dc1234d616ad1122b24e',
        worktree_tree_oid: 'b76855f51f08f8884423dc1234d616ad1122b24e',
      },
      environment: { node: 'v22.9.0' },
      protocol: {
        warmups: 3,
        trials: 20,
        persistent_warm_session: false,
        shipping_path: 'cold_noop_or_full_canonical_reconcile',
      },
      gates: {
        subject_identity: { pass: true },
        sample_protocol: { pass: true },
        corpus_eligibility: { pass: true },
        cold_noop_p50_ratio: { actual: 0.065, pass: true },
        cold_noop_zero_parse: { pass: true },
        clean_generation_regression: { baseline_compatible: true, ratio: 1.08, pass: true },
      },
    })
  })

  it('keeps retired exporter flags out of active commands without rewriting frozen v0.32 evidence', () => {
    expect(read('.github/workflows/ci.yml')).not.toContain('--no-html')
    expect(read('.github/ISSUE_TEMPLATE/design_partner_report.yml')).not.toContain('--no-html')
    expect(read('tools/eval/core-reset/record-baseline.mjs')).toContain("'--no-html'")
    expect(read('tools/eval/core-reset/contracts/evaluation-contract.json')).toContain('"--no-html"')
    expect(read('docs/core-reset/evidence/baseline-v0.32.0.json')).toContain('"--no-html"')
  })

  it('assigns every production TypeScript file to exactly one removal-manifest item', () => {
    const manifest = parse(read('docs/core-reset/removal-manifest.yml')) as {
      current: { production_typescript_files: number }
      review: {
        status: string
        production_files_reviewed: number
        files_with_one_owner: number
        unowned_files: number
        overlapping_files: number
        disposition_changes: number
        amendment: string
      }
      items: Array<{
        id: string
        status: string
        absorbs?: string[]
        absorbed_by?: string
        sources?: string[]
        removed_sources?: string[]
        transferred_sources?: string[]
        preserve?: string[]
        completion?: { commit: string }
      }>
    }
    const productionFiles = productionTypeScriptFiles()

    expect(productionFiles).toHaveLength(manifest.current.production_typescript_files)
    for (const file of productionFiles) {
      const owners = manifest.items.filter((item) =>
        (item.sources ?? []).some((pattern) => manifestGlob(pattern).test(file)))
      expect(owners.map((item) => item.id), `${file} must have exactly one owner`).toHaveLength(1)
    }
    const legacy = manifest.items.find((item) => item.id === 'legacy-extraction')
    const transferred = [
      'src/application/build-graph.ts',
      'src/core/provenance/ingest.ts',
      'src/infrastructure/cache.ts',
      'src/infrastructure/capabilities.ts',
    ]
    expect(legacy?.removed_sources?.filter((source) => transferred.includes(source))).toEqual(transferred)
    for (const source of transferred) {
      expect(
        manifest.items
          .filter((item) => item.id !== 'legacy-extraction')
          .filter((item) => (item.sources ?? []).some((pattern) => manifestGlob(pattern).test(source)))
          .map((item) => item.id),
        `${source} must transfer exclusively to legacy-extraction`,
      ).toEqual([])
    }
    const generation = manifest.items.find((item) => item.id === 'generation-and-incremental')
    expect(generation?.transferred_sources).toEqual(Object.keys(INCREMENTAL_TRANSFERS))
    for (const [source, expectedOwner] of Object.entries(INCREMENTAL_TRANSFERS)) {
      expect(generation?.sources ?? [], `${source} cannot remain owned by generation`).not.toContain(source)
      expect(
        manifest.items
          .filter((item) => (item.sources ?? []).some((pattern) => manifestGlob(pattern).test(source)))
          .map((item) => item.id),
        `${source} must have one transferred owner`,
      ).toEqual([expectedOwner])
    }
    const evidencePath = manifest.items.find((item) => item.id === 'evidence-path-query')
    const thinDelivery = manifest.items.find((item) => item.id === 'thin-delivery')
    expect(evidencePath?.transferred_sources).toEqual([
      'src/core/pipeline/stage.ts',
      'src/runtime/freshness.ts',
      'src/shared/source-discovery.ts',
    ])
    expect(evidencePath?.preserve).toEqual([
      'SourceDomain',
      'classifySourceDomain',
      'isPollutedSourcePath',
      'private helpers required only by those query-classification exports',
    ])
    expect(thinDelivery?.transferred_sources).toEqual(['src/infrastructure/doctor.ts'])
    expect(evidencePath?.status).toBe('proposed')
    expect(thinDelivery?.status).toBe('proposed')
    for (const completedId of ['directed-multigraph', 'canonical-typescript-index', 'legacy-extraction']) {
      const completed = manifest.items.find((item) => item.id === completedId)
      expect(completed).toBeDefined()
      expect(completed?.completion?.commit).toBeDefined()
      const completedOwnerIds = new Set([completedId, ...(completed?.absorbs ?? [])])
      const completedOwners = manifest.items.filter((item) => completedOwnerIds.has(item.id))
      expect(completedOwners).toHaveLength(completedOwnerIds.size)
      const removedSources = completedOwners.flatMap((item) => item.removed_sources ?? [])
      const deletedFiles = deletedProductionFiles(completed!.completion!.commit)
      const deletedPredecessors = deletedFiles.filter((path) =>
        removedSources.some((pattern) => manifestGlob(pattern).test(path)))
      expect(
        [...deletedPredecessors].sort(),
        `${completedId} removed_sources must account for every production TypeScript deletion`,
      ).toEqual([...deletedFiles].sort())

      for (const removed of removedSources) {
        const removedPattern = manifestGlob(removed)
        expect(
          deletedPredecessors.some((path) => removedPattern.test(path)),
          `${removed} must be evidenced as deleted by ${completedId}`,
        ).toBe(true)
        expect(
          productionFiles.filter((file) => removedPattern.test(file)),
          `${removed} must be deleted by ${completedId}`,
        ).toEqual([])
      }

      for (const removedFile of deletedPredecessors) {
        const futureOwners = manifest.items.filter((item) =>
          !completedOwnerIds.has(item.id) && (item.sources ?? []).some((pattern) => manifestGlob(pattern).test(removedFile)))
        expect(futureOwners.map((item) => item.id), `${removedFile} cannot remain assigned to a later phase`).toEqual([])
      }
    }
    expect(manifest.review).toMatchObject({
      status: 'complete',
      production_files_reviewed: 181,
      files_with_one_owner: 181,
      unowned_files: 0,
      overlapping_files: 0,
      disposition_changes: 4,
    })
    expect(manifest.review.amendment).toContain('Approved issue #592 transfers')
  })

  it('routes contributors through the reset contract', () => {
    const issueConfig = read('.github/ISSUE_TEMPLATE/config.yml')
    const workItem = parse(read('.github/ISSUE_TEMPLATE/core_reset_work_item.yml')) as {
      body: Array<{
        id?: string
        validations?: { required?: boolean }
        attributes?: { options?: Array<{ required?: boolean }> }
      }>
    }
    const pullRequestTemplate = read('.github/pull_request_template.md')

    expect(issueConfig).toContain('/blob/main/docs/roadmap.md')
    expect(issueConfig).not.toContain('/issues/155')

    const requiredFieldIds = [
      'parent',
      'problem',
      'manifest',
      'dependencies',
      'implementation',
      'deletion',
      'budget',
      'gates',
      'verification',
      'non_goals',
    ]
    for (const id of requiredFieldIds) {
      expect(workItem.body.find((field) => field.id === id)?.validations?.required).toBe(true)
    }
    const resetContract = workItem.body.find((field) => field.id === 'reset_contract')
    expect(resetContract?.attributes?.options?.length).toBeGreaterThan(0)
    expect(resetContract?.attributes?.options?.every((option) => option.required)).toBe(true)

    expect(pullRequestTemplate).toContain('## Core Reset contract')
    expect(pullRequestTemplate).toContain('Removal-manifest IDs')
    expect(pullRequestTemplate).toContain('Net production LOC')
  })

  it('does not retain stale completed-phase language', () => {
    const governance = `${read('docs/roadmap.md')}\n${read('docs/core-reset/scorecard.md')}\n${read('docs/designs/2026-07-19-core-reset.md')}`
    expect(governance).not.toContain('candidate evidence')
    expect(governance).not.toContain('pending PR review')
    expect(governance).not.toContain('Final CI matrix, CodeRabbit, and unresolved-thread evidence remains pending')
    expect(governance).not.toContain('single In progress phase through #588')
    expect(governance).not.toContain('Legacy and non-code deletion contract (in progress)')
    expect(governance).not.toContain('## Ready — generation and incremental index')
    expect(governance).not.toContain('Ready — not In progress')
    expect(governance).not.toContain('No phase is In progress')
    expect(governance).not.toContain('scope and baseline is the only authorized phase')
  })
})
