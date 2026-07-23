import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
import { join, posix, resolve } from 'node:path'

import ts from 'typescript'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

// Development-only JavaScript is deliberately outside the production TypeScript build.
// @ts-expect-error -- the isolated evaluator does not ship declarations in the npm package
import { productionSourceDelta, sourceInventory } from '../../tools/eval/core-reset/record-baseline.mjs'

const read = (path: string): string => readFileSync(resolve(path), 'utf8')
const git = process.platform === 'win32' ? 'git.exe' : 'git'
const INCREMENTAL_BASE = '8886a0299ee30765ce149ca7ad5d1779496b78b5'
const INCREMENTAL_IMPLEMENTATION = '1be24dc45a5f07c352c74fc374feb95a9440df8e'
const INCREMENTAL_MERGE = 'b56966c06c0ae1b04c252f297036f332fa1b384c'
const INCREMENTAL_CI_HEAD = '3f40c5b64cdd63054c52ed67588b782034f8b935'
const INCREMENTAL_CI_RUN = 'https://github.com/mohanagy/madar/actions/runs/29942216697'
const INCREMENTAL_REVIEW_RECEIPT = 'https://github.com/mohanagy/madar/pull/594#issuecomment-5049404550'
const INCREMENTAL_MUTATION_RECEIPT = 'docs/core-reset/evidence/generation-mutation-equivalence.json'
const INCREMENTAL_MUTATION_RECEIPT_SHA256 = '831bce005c0e9cb28f768a2c490e1923e8062344fd2fd9710be5376e5603f67d'
const INCREMENTAL_FINAL_TREE = '0cead2d3488dac136affa4bec047f8b5f11418a3'
const STOPPED_INCREMENTAL_CANDIDATE = '1d3c9b6d264a5c76d212b93da7c63718cbe49b3d'
const STOPPED_INCREMENTAL_TREE = '6bd1ae5762afaa868d5cf6ce165b061aa290bfda'
const EVIDENCE_BASE = 'bce4f4fb1520a582bfedf5eab9133e9befbc79f7'
const EVIDENCE_BASE_TREE = '7ac3c1ef990ee628ca5c9a215ae6388c82dabcd3'
const EVIDENCE_ISSUE = 'https://github.com/mohanagy/madar/issues/596'
const EVIDENCE_OWNER_APPROVAL = `${EVIDENCE_ISSUE}#issuecomment-5050888977`
const EVIDENCE_RFC_AMENDMENT = 'https://github.com/mohanagy/madar/issues/577#issuecomment-5050889198'
const EVIDENCE_PERFORMANCE_AMENDMENT = `${EVIDENCE_ISSUE}#issuecomment-5051857404`
const EVIDENCE_PERFORMANCE_RFC_AMENDMENT = 'https://github.com/mohanagy/madar/issues/577#issuecomment-5051857542'
const EVIDENCE_SOURCE_AMENDMENT = `${EVIDENCE_ISSUE}#issuecomment-5052210144`
const EVIDENCE_SOURCE_RFC_AMENDMENT = 'https://github.com/mohanagy/madar/issues/577#issuecomment-5052210334'
const EVIDENCE_SOURCE_OWNER_APPROVAL = `${EVIDENCE_ISSUE}#issuecomment-5054853667`
const EVIDENCE_SOURCE_RFC_APPROVAL = 'https://github.com/mohanagy/madar/issues/577#issuecomment-5054853815'
const EVIDENCE_PERFORMANCE_DESCRIPTOR = 'tools/eval/core-reset/contracts/evidence-path-performance-v1.json'
const EVIDENCE_PERFORMANCE_DESCRIPTOR_SHA256 = '076e655e7b8ab01cc94c4c95c32b13d70f888c02948ff4eb7c1acebb4427953c'
const EVIDENCE_PERFORMANCE_RECEIPT = 'docs/core-reset/evidence/evidence-path-performance.json'
const EVIDENCE_IMPORTER_RECEIPT = 'docs/core-reset/evidence/evidence-path-importer-closure.json'
const EVIDENCE_IMPORTER_RECEIPT_SHA256 = '6b35797f0625e69708fca3441d12b1aea565275f8bd585f3a0fe56f8958f07b3'
const FROZEN_EVIDENCE_HASHES = {
  'tools/eval/core-reset/contracts/evaluation-contract.json': '3a3272df5c294ab0e3a4f2ace815fbd120941a432f85a616b9624f420de86b3b',
  'tools/eval/core-reset/schemas/evaluation-contract.schema.json': '34ca0bfc94c117eb79a5ec5d701af1c8fa0335a3a1c41cf44cf016952a48c889',
  'docs/core-reset/evidence/baseline-v0.32.0.json': 'c2b96e75e64934de998bb5c7087cb604b680cd8fd2aa5c6d1f74cd9f1a0c6516',
  'tools/eval/core-reset/schemas/baseline-receipt.schema.json': '04eeb47a14da18ec90c6e687bbd557d44a3fe5ac493d8d6946f4b3fc4f7f6a59',
} as const
const EVIDENCE_TRANSFERS = [
  'src/core/pipeline/stage.ts',
  'src/runtime/freshness.ts',
  'src/shared/source-discovery.ts',
  'src/runtime/semantic.ts',
  'src/runtime/http-server.ts',
  'src/infrastructure/time-travel.ts',
  'src/runtime/time-travel.ts',
  'src/infrastructure/context-pack-command.ts',
  'src/infrastructure/context-prompt-command.ts',
  'src/infrastructure/context-prompt.ts',
  'src/infrastructure/handoff-command.ts',
  'src/infrastructure/proof-report.ts',
  'src/infrastructure/review-compare.ts',
] as const
const EVIDENCE_REPLACEMENTS = [
  'src/domain/query/types.ts',
  'src/domain/query/source-domain.ts',
  'src/domain/query/rank.ts',
  'src/domain/query/traverse.ts',
  'src/domain/query/slice.ts',
  'src/domain/query/index-status.ts',
  'src/application/retrieve-context.ts',
] as const
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

const gitBlobSha256 = (revision: string, path: string): string =>
  createHash('sha256').update(execFileSync(git, ['show', `${revision}:${path}`])).digest('hex')

function importedProductionFilesAtCommit(
  commit: string,
  importer: string,
  productionFiles: ReadonlySet<string>,
): string[] {
  const source = execFileSync(git, ['show', `${commit}:${importer}`], { encoding: 'utf8' })
  const sourceFile = ts.createSourceFile(importer, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const moduleSpecifiers = new Set<string>()

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      moduleSpecifiers.add(node.moduleSpecifier.text)
    }
    if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression
      && ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      moduleSpecifiers.add(node.moduleReference.expression.text)
    }
    const argument = ts.isCallExpression(node) ? node.arguments[0] : undefined
    if (
      ts.isCallExpression(node)
      && node.arguments.length === 1
      && argument
      && ts.isStringLiteralLike(argument)
      && (
        node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      )
    ) {
      moduleSpecifiers.add(argument.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  return [...moduleSpecifiers].flatMap((specifier) => {
    if (!specifier.startsWith('.')) return []
    const unresolved = posix.normalize(posix.join(posix.dirname(importer), specifier))
    const candidates = [
      unresolved,
      unresolved.replace(/\.(?:cjs|js|jsx|mjs)$/, '.ts'),
      `${unresolved}.ts`,
      `${unresolved}/index.ts`,
    ]
    return candidates.find((candidate) => productionFiles.has(candidate)) ?? []
  }).filter((target, index, targets) => targets.indexOf(target) === index).sort()
}

function deletionImportEdgesAtCommit(commit: string, deletionFiles: ReadonlySet<string>): {
  all: string[]
  internal: string[]
  surviving: string[]
} {
  const productionFiles = productionTypeScriptFilesAtCommit(commit)
  const productionFileSet = new Set(productionFiles)
  const all = productionFiles.flatMap((importer) =>
    importedProductionFilesAtCommit(commit, importer, productionFileSet)
      .filter((target) => deletionFiles.has(target))
      .map((target) => `${importer}\0${target}`),
  ).filter((edge, index, edges) => edges.indexOf(edge) === index).sort()
  return {
    all,
    internal: all.filter((edge) => deletionFiles.has(edge.slice(0, edge.indexOf('\0')))),
    surviving: all.filter((edge) => !deletionFiles.has(edge.slice(0, edge.indexOf('\0')))),
  }
}

const edgeListSha256 = (edges: readonly string[]): string =>
  createHash('sha256').update(`${edges.join('\n')}\n`).digest('hex')

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
    expect(roadmap).toContain('## Passed — generation and reconciliation')
    expect(roadmap).toContain('## In progress — evidence-path query')
    expect(roadmap).toContain(EVIDENCE_OWNER_APPROVAL)
    expect(roadmap).toContain(EVIDENCE_RFC_AMENDMENT)
    expect(roadmap).toContain(EVIDENCE_PERFORMANCE_AMENDMENT)
    expect(roadmap).toContain(EVIDENCE_PERFORMANCE_RFC_AMENDMENT)
    expect(roadmap).toContain(EVIDENCE_SOURCE_AMENDMENT)
    expect(roadmap).toContain(EVIDENCE_SOURCE_RFC_AMENDMENT)
    expect(roadmap).toContain(EVIDENCE_SOURCE_OWNER_APPROVAL)
    expect(roadmap).toContain(EVIDENCE_SOURCE_RFC_APPROVAL)
    expect(roadmap).toContain('normalized retrieve request, canonical graph bytes, and identical authenticated source snapshot')
    expect(roadmap).toContain('an empty positive result fails')
    expect(roadmap).toContain('54 predecessor files / 29,441 LOC')
    expect(roadmap).toContain('Every implementation, deletion, held-out, performance, package, CI, and review result remains pending')
    expect(roadmap).toContain('issues/592')
    expect(roadmap).toContain('issues/588')
    expect(roadmap).not.toContain('## Ready — generation and incremental index')
    expect(roadmap).not.toContain('## Ready — evidence-path query')
    expect(roadmap).not.toContain('## In progress — generation and incremental index')
    expect(roadmap).not.toContain('## In progress — canonical TypeScript/JavaScript index')
    expect(roadmap).not.toContain('## In progress — delete legacy extraction and non-code/other-language ingestion')
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
    expect(design).toContain('## Completed amendment — generation and reconciliation')
    expect(design).toContain('## Active amendment — generic evidence-path query')
    expect(design).toContain(EVIDENCE_OWNER_APPROVAL)
    expect(design).toContain(EVIDENCE_RFC_AMENDMENT)
    expect(design).toContain(EVIDENCE_PERFORMANCE_AMENDMENT)
    expect(design).toContain(EVIDENCE_PERFORMANCE_RFC_AMENDMENT)
    expect(design).toContain(EVIDENCE_SOURCE_AMENDMENT)
    expect(design).toContain(EVIDENCE_SOURCE_RFC_AMENDMENT)
    expect(design).toContain(EVIDENCE_SOURCE_OWNER_APPROVAL)
    expect(design).toContain(EVIDENCE_SOURCE_RFC_APPROVAL)
    expect(design).toContain('Implementation remains paused until this governance correction merges')
    expect(design).toContain('SHA-256 of the complete UTF-8 source equals the graph hash')
    expect(design).toContain('Identical normalized request plus identical canonical graph bytes plus the identical authenticated source snapshot')
    expect(design).toContain('All five expectations must pass before warmup')
    expect(design).toContain('empty positive results, missing/extra nodes or edges, reversed/wrong relationship kinds')
    expect(design).toContain('`evidence-path-query` is the sole active phase')
    expect(design).toContain('implementation evidence and does not exist or pass at activation')
    expect(design).not.toContain('## Active amendment — generation and incremental index')
    expect(design).not.toContain('the phase remains active')
    expect(design).not.toContain('completion evidence remains open')
    expect(design).not.toContain('Every returned node, relationship, file, range, and snippet must exist in the authoritative `graph.json`')
    expect(design).not.toContain('Identical question plus identical graph bytes must produce byte-identical output')
    expect(scorecard).toContain('**Status:** accepted')
    expect(scorecard).toContain('| Directed multigraph | **Passed**')
    expect(scorecard).toContain('| Canonical TypeScript index | **Passed**')
    expect(scorecard).toContain('| Legacy extraction plus non-code/other-language ingestion | **Passed**')
    expect(scorecard).toContain('| Generation and reconciliation | **Passed**')
    expect(scorecard).toContain('| Evidence-path query | **In progress**')
    expect(scorecard).toContain(EVIDENCE_OWNER_APPROVAL)
    expect(scorecard).toContain(EVIDENCE_RFC_AMENDMENT)
    expect(scorecard).toContain(EVIDENCE_PERFORMANCE_AMENDMENT)
    expect(scorecard).toContain(EVIDENCE_PERFORMANCE_RFC_AMENDMENT)
    expect(scorecard).toContain(EVIDENCE_SOURCE_AMENDMENT)
    expect(scorecard).toContain(EVIDENCE_SOURCE_OWNER_APPROVAL)
    expect(scorecard).toContain(EVIDENCE_SOURCE_RFC_APPROVAL)
    expect(scorecard).toContain('complete UTF-8 SHA-256 equals the canonical file-node `content_hash`')
    expect(scorecard).toContain('Identical normalized request plus identical canonical graph bytes')
    expect(scorecard).toContain('every warmup/measured result must remain correct; an empty positive result fails')
    expect(scorecard).toContain('`evidence-path-query` is the single In progress phase')
    expect(scorecard).toContain('No implementation, deletion, held-out, timing, package, dependency, CI, or review gate is reported as passed')
    expect(scorecard).toContain('clean generation stays within the accepted 10% regression limit')
    expect(scorecard).toContain('recognized unsupported files and expected policy exclusions are informational')
    expect(scorecard).toContain('The fixed 500-file experiment stopped the incremental design')
    expect(scorecard).toContain('There is no in-memory or disk session cache')
    expect(scorecard).not.toContain('single In progress phase through #592')
    expect(scorecard).not.toContain('phase stays **In progress**')
    expect(scorecard).not.toContain('phase completion awaits')
    expect(scorecard).not.toContain('Every returned node, edge, snippet, range, and direction must exist in `graph.json`')
    expect(scorecard).not.toContain('identical question plus identical graph bytes must produce byte-identical output')
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
          implementation_commit?: string
          final_pr_head?: string
          ci_head?: string
          outcome?: string
          production_files_added?: number
          production_files_removed?: number
          production_typescript_files: number
          production_typescript_loc: number
          production_loc_added: number
          production_loc_removed: number
          production_loc_net: number
          replacement_loc?: number
          dependencies_added: number
          dependencies_removed?: number
          runtime_dependencies_added?: number
          development_dependencies_added?: number
          npm_files?: number
          npm_packed_bytes?: number
          npm_unpacked_bytes?: number
          ci_matrix_jobs_passed: number
          ci_run?: string
          test_files_passed?: number
          tests_passed?: number
          tests_skipped?: number
          coverage_statements_percent?: number
          coverage_branches_percent?: number
          coverage_functions_percent?: number
          coverage_lines_percent?: number
          coderabbit: string
          coderabbit_findings_addressed?: number
          coderabbit_findings_confirmed?: number
          coderabbit_review_body_nitpicks_addressed?: number
          independent_review?: string
          independent_reviews_passed?: number
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
      updated_at: '2026-07-23',
      completed_phase: 'generation-and-incremental',
      active_phase: 'evidence-path-query',
      ready_phase: null,
      base_commit: EVIDENCE_BASE,
      completed_phase_commit: INCREMENTAL_MERGE,
      production_typescript_files: 130,
      production_typescript_loc: 66_418,
      production_loc_added: 0,
      production_loc_removed: 0,
      production_loc_net: 0,
      npm_files: 276,
      npm_packed_bytes: 572_143,
      npm_unpacked_bytes: 2_699_851,
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
    expect(manifest.items.filter((item) => item.status === 'in_progress').map((item) => item.id))
      .toEqual(['evidence-path-query'])
    expect(generation).toMatchObject({
      status: 'complete',
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
          INCREMENTAL_MUTATION_RECEIPT,
        ],
      },
      completion: {
        issue: 'https://github.com/mohanagy/madar/issues/592',
        pull_request: 'https://github.com/mohanagy/madar/pull/594',
        commit: INCREMENTAL_MERGE,
        implementation_commit: INCREMENTAL_IMPLEMENTATION,
        final_pr_head: INCREMENTAL_CI_HEAD,
        ci_head: INCREMENTAL_CI_HEAD,
        outcome: 'cold_noop_or_full_canonical_reconcile_after_incremental_stop',
        production_files_added: 6,
        production_files_removed: 15,
        production_typescript_files: 130,
        production_typescript_loc: 66_418,
        production_loc_added: 2_190,
        production_loc_removed: 4_726,
        production_loc_net: -2_536,
        replacement_loc: 1_484,
        dependencies_added: 0,
        dependencies_removed: 0,
        runtime_dependencies_added: 0,
        development_dependencies_added: 0,
        npm_files: 276,
        npm_packed_bytes: 572_143,
        npm_unpacked_bytes: 2_699_851,
        ci_matrix_jobs_passed: 6,
        ci_run: INCREMENTAL_CI_RUN,
        test_files_passed: 156,
        tests_passed: 1_885,
        tests_skipped: 2,
        coverage_statements_percent: 84.44,
        coverage_branches_percent: 76.64,
        coverage_functions_percent: 89.57,
        coverage_lines_percent: 85.34,
        coderabbit: 'skipped_base_owner_exception',
        independent_review: 'passed',
        independent_reviews_passed: 3,
        independent_review_receipt: INCREMENTAL_REVIEW_RECEIPT,
        unresolved_review_threads: 0,
      },
    })
    const incrementalBaseFiles = productionTypeScriptFilesAtCommit(INCREMENTAL_BASE)
    expect(INCREMENTAL_PREDECESSORS.every((path) => incrementalBaseFiles.includes(path))).toBe(true)
    expect(INCREMENTAL_PREDECESSORS.every((path) => !existsSync(resolve(path)))).toBe(true)
    expect(INCREMENTAL_REPLACEMENTS.every((path) => existsSync(resolve(path)))).toBe(true)
    expect(logicalLocAtCommit(INCREMENTAL_BASE, INCREMENTAL_PREDECESSORS)).toBe(3_839)
    expect(manifest.items.find((item) => item.id === 'evidence-path-query')?.status).toBe('in_progress')
    expect(manifest.items.find((item) => item.id === 'thin-delivery')?.status).toBe('proposed')
  })

  it('freezes the accepted evidence-path activation without claiming implementation', () => {
    const manifest = parse(read('docs/core-reset/removal-manifest.yml')) as {
      review: { disposition_changes: number; amendment: string }
      current: {
        completed_phase: string
        active_phase: string | null
        ready_phase: string | null
        base_commit: string
        completed_phase_commit: string
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
        sources?: string[]
        absorbs?: string[]
        absorbed_by?: string
        blocked_by?: string
        transferred_sources?: string[]
        replacement_sources?: string[]
        predecessor_contract?: {
          files: number
          production_loc: number
          transferred_sources: number
          absorbed_handles: number
        }
        production_file_budget?: { added_max: number; removed_min: number }
        production_loc_budget?: { added_max: number; removed_min: number; net_max: number }
        runtime_dependency_budget?: { added_max: number }
        development_dependency_budget?: { added_max: number }
        optional_peer_metadata_to_remove?: string[]
        final_source_budget?: { files_max: number; loc_max: number }
        npm_package_budget?: {
          files_max: number
          unpacked_bytes_max: number
          packed_bytes_delta_max: number
        }
        deterministic_query_contract?: {
          graph_authoritative_for_selection_and_graph_facts: boolean
          preserve_typed_directional_relationships: boolean
          disconnected_boundaries_explicit: boolean
          missing_and_unsupported_boundaries_explicit: boolean
          stale_unavailable_corrupt_and_truncated_boundaries_explicit: boolean
          duplicate_evidence_forbidden: boolean
          authenticated_source_excerpt: {
            source_layer: string
            source_root: string
            graph_fields_required: string[]
            source_path_must_remain_beneath_root: boolean
            hash_algorithm: string
            hash_must_equal: string
            excerpt: string
            unauthenticated_or_synthesized_snippet: string
            missing_unreadable_or_escape: string
            hash_mismatch_or_invalid_range: string
          }
          determinism_inputs: string[]
          closure_pass_max: number
          global_confidence_score: string
          planner_or_recursive_recovery: string
          hidden_second_query_or_model_call: string
          repository_specific_rules: string
        }
        retrieve_input_contract?: {
          allowed_keys: string[]
          additional_properties: string
          question: string
          budget: string
          forbidden_legacy_controls: string[]
        }
        surviving_caller_contract?: {
          compare_legacy_response_branches: string
          installer_applicability_hook_generation: string
          heldout_and_performance_runners: string
          compatibility_types_or_engine: string
        }
        heldout_contract?: {
          id: string
          contract: string
          contract_sha256: string
          contract_schema: string
          contract_schema_sha256: string
          baseline_receipt: string
          baseline_receipt_sha256: string
          baseline_receipt_schema: string
          baseline_receipt_schema_sha256: string
          blocking_repositories: Array<{
            question: string
            repository: string
            commit: string
            tree_path_sha256: string
            graph_root: string
            required_phases: string[]
          }>
          diagnostic_scope_guard: {
            question: string
            repository: string
            commit: string
            tree_path_sha256: string
            graph_root: string
            required_typescript_phases: string[]
            unsupported_phases: string[]
          }
          query_invocations_max: number
          required_phase_coverage: number
          direct_phase_evidence_requires_authenticated_excerpt: boolean
          verification_targets_cover_blocking_phases: boolean
          selected_file_precision_min: number
          unrelated_files_max: number
          selected_files_max: number
          snippets_max: number
          serialized_tokens_max: number
          incorrect_load_bearing_paths_max: number
        }
        performance_contract?: {
          id: string
          descriptor: string
          descriptor_sha256: string
          generator: string
          nodes: number
          directed_edges: number
          graph_loaded_before_timer: boolean
          positive_queries: number
          missing_queries: number
          untimed_preflight_invocations_per_query: number
          preflight_must_pass_before_warmup: boolean
          every_warmup_and_measured_result_must_match: boolean
          empty_positive_result: string
          warmups: number
          measured_queries_min: number
          warm_retrieval_p95_ms_max: number
          closure_pass_max: number
          reference_environment: {
            node: string
            platform: string
            release: string
            arch: string
            cpu: string
            memory_bytes: number
          }
          receipt: string
          runner: string
        }
        importer_closure_contract?: {
          receipt: string
          receipt_sha256: string
          subject_commit: string
          subject_tree: string
          predecessor_files: number
          predecessor_loc: number
          all_edges: number
          internal_deleted_importers: number
          internal_edges: number
          surviving_direct_importers: number
          surviving_edges: number
          transfers: number
          surface_only_callers: number
          unexpected_direct_importers: number
          activation_state: string
        }
        activation?: {
          issue: string
          owner_approval: string
          rfc_amendment: string
          performance_amendment: string
          performance_rfc_amendment: string
          authenticated_source_amendment: string
          authenticated_source_rfc_amendment: string
          authenticated_source_owner_approval: string
          authenticated_source_rfc_approval: string
          protected_base: string
          implementation_started?: boolean
        }
      }>
    }

    expect(execFileSync(git, ['rev-parse', `${EVIDENCE_BASE}^{tree}`], { encoding: 'utf8' }).trim())
      .toBe(EVIDENCE_BASE_TREE)
    expect(manifest.current).toEqual({
      updated_at: '2026-07-23',
      completed_phase: 'generation-and-incremental',
      active_phase: 'evidence-path-query',
      ready_phase: null,
      base_commit: EVIDENCE_BASE,
      completed_phase_commit: INCREMENTAL_MERGE,
      production_typescript_files: 130,
      production_typescript_loc: 66_418,
      production_loc_added: 0,
      production_loc_removed: 0,
      production_loc_net: 0,
      npm_files: 276,
      npm_packed_bytes: 572_143,
      npm_unpacked_bytes: 2_699_851,
    })
    expect(manifest.items.filter((item) => item.status === 'in_progress').map((item) => item.id))
      .toEqual(['evidence-path-query'])

    const evidence = manifest.items.find((item) => item.id === 'evidence-path-query')
    expect(evidence).toMatchObject({
      disposition: 'rebuild',
      status: 'in_progress',
      absorbs: ['context-governance-stack', 'derived-product-wrappers'],
      transferred_sources: [...EVIDENCE_TRANSFERS],
      replacement_sources: [...EVIDENCE_REPLACEMENTS],
      predecessor_contract: {
        files: 54,
        production_loc: 29_441,
        transferred_sources: 13,
        absorbed_handles: 2,
      },
      production_file_budget: { added_max: 7, removed_min: 54 },
      production_loc_budget: { added_max: 3_500, removed_min: 29_441, net_max: -25_900 },
      runtime_dependency_budget: { added_max: 0 },
      development_dependency_budget: { added_max: 0 },
      optional_peer_metadata_to_remove: ['@huggingface/transformers'],
      final_source_budget: { files_max: 83, loc_max: 40_500 },
      npm_package_budget: {
        files_max: 210,
        unpacked_bytes_max: 2_200_000,
        packed_bytes_delta_max: -1,
      },
      deterministic_query_contract: {
        graph_authoritative_for_selection_and_graph_facts: true,
        preserve_typed_directional_relationships: true,
        disconnected_boundaries_explicit: true,
        missing_and_unsupported_boundaries_explicit: true,
        stale_unavailable_corrupt_and_truncated_boundaries_explicit: true,
        duplicate_evidence_forbidden: true,
        authenticated_source_excerpt: {
          source_layer: 'application',
          graph_fields_required: [
            'node',
            'source_file',
            'line_number',
            'end_line_number',
            'provenance',
            'canonical_file_node.content_hash',
          ],
          source_root: 'graph_root',
          source_path_must_remain_beneath_root: true,
          hash_algorithm: 'sha256_complete_utf8_source',
          hash_must_equal: 'canonical_file_node.content_hash',
          excerpt: 'exact_graph_range_text_only',
          unauthenticated_or_synthesized_snippet: 'forbidden',
          missing_unreadable_or_escape: 'unavailable_without_snippet',
          hash_mismatch_or_invalid_range: 'stale_without_snippet',
        },
        determinism_inputs: [
          'normalized_retrieve_request',
          'canonical_graph_bytes',
          'authenticated_source_snapshot',
        ],
        closure_pass_max: 1,
        global_confidence_score: 'forbidden',
        planner_or_recursive_recovery: 'forbidden',
        hidden_second_query_or_model_call: 'forbidden',
        repository_specific_rules: 'forbidden',
      },
      retrieve_input_contract: {
        allowed_keys: ['question', 'budget'],
        additional_properties: 'forbidden',
        question: 'required',
        budget: 'optional_and_part_of_normalized_request',
        forbidden_legacy_controls: ['semantic', 'rerank', 'strategy', 'session', 'mode'],
      },
      surviving_caller_contract: {
        compare_legacy_response_branches: 'delete',
        installer_applicability_hook_generation: 'delete',
        heldout_and_performance_runners: 'development_only',
        compatibility_types_or_engine: 'forbidden',
      },
      heldout_contract: {
        id: 'core-reset-held-out-v1',
        contract: 'tools/eval/core-reset/contracts/evaluation-contract.json',
        contract_sha256: FROZEN_EVIDENCE_HASHES['tools/eval/core-reset/contracts/evaluation-contract.json'],
        contract_schema: 'tools/eval/core-reset/schemas/evaluation-contract.schema.json',
        contract_schema_sha256: FROZEN_EVIDENCE_HASHES['tools/eval/core-reset/schemas/evaluation-contract.schema.json'],
        baseline_receipt: 'docs/core-reset/evidence/baseline-v0.32.0.json',
        baseline_receipt_sha256: FROZEN_EVIDENCE_HASHES['docs/core-reset/evidence/baseline-v0.32.0.json'],
        baseline_receipt_schema: 'tools/eval/core-reset/schemas/baseline-receipt.schema.json',
        baseline_receipt_schema_sha256: FROZEN_EVIDENCE_HASHES['tools/eval/core-reset/schemas/baseline-receipt.schema.json'],
        blocking_repositories: [
          {
            question: 'documenso-document-send',
            repository: 'documenso',
            commit: '4ee789ea378d12c85daacf7dceda80b4dec80652',
            tree_path_sha256: '48728969cb89adeb6567f030a41fdf380e6c523473a04d3a264a4f4970b95709',
            graph_root: 'packages/lib',
            required_phases: [
              'recipient_creation',
              'document_send',
              'signing_completion',
              'notification_delivery',
            ],
          },
          {
            question: 'formbricks-survey-response',
            repository: 'formbricks',
            commit: '415bd9828ba150f7944fe10422acdbaf3089c707',
            tree_path_sha256: 'd50418a92fd6dae8d07ad09e4aaecbefb53c5ed29c85e374d41320e0669a7572',
            graph_root: 'apps/web',
            required_phases: ['request_handling', 'response_persistence', 'event_tracking'],
          },
        ],
        diagnostic_scope_guard: {
          question: 'openstatus-574-strict-one-call',
          repository: 'openstatus',
          commit: '295e5a72f52c172d326aa950e81043e72a4f20c0',
          tree_path_sha256: '9ccb1f1dce50c03ea67703953c124cb6026ee978a97be4f358d7276c20e764f4',
          graph_root: '.',
          required_typescript_phases: [
            'incident_mutation',
            'notification_delivery',
            'public_html',
            'json_feeds',
          ],
          unsupported_phases: ['checker_detection', 'tinybird_persistence'],
        },
        query_invocations_max: 1,
        required_phase_coverage: 1,
        direct_phase_evidence_requires_authenticated_excerpt: true,
        verification_targets_cover_blocking_phases: false,
        selected_file_precision_min: 0.70,
        unrelated_files_max: 2,
        selected_files_max: 12,
        snippets_max: 25,
        serialized_tokens_max: 4_000,
        incorrect_load_bearing_paths_max: 0,
      },
      performance_contract: {
        id: 'evidence-path-performance-v1',
        descriptor: EVIDENCE_PERFORMANCE_DESCRIPTOR,
        descriptor_sha256: EVIDENCE_PERFORMANCE_DESCRIPTOR_SHA256,
        generator: 'component-ring-with-fixed-skip-v1',
        nodes: 15_000,
        directed_edges: 30_000,
        graph_loaded_before_timer: true,
        positive_queries: 4,
        missing_queries: 1,
        untimed_preflight_invocations_per_query: 1,
        preflight_must_pass_before_warmup: true,
        every_warmup_and_measured_result_must_match: true,
        empty_positive_result: 'fail',
        warmups: 3,
        measured_queries_min: 20,
        warm_retrieval_p95_ms_max: 500,
        closure_pass_max: 1,
        reference_environment: {
          node: 'v22.9.0',
          platform: 'darwin',
          release: '25.3.0',
          arch: 'arm64',
          cpu: 'Apple M3 Max',
          memory_bytes: 51_539_607_552,
        },
        receipt: EVIDENCE_PERFORMANCE_RECEIPT,
        runner: `node tools/eval/core-reset/evidence-path-performance.mjs --contract ${EVIDENCE_PERFORMANCE_DESCRIPTOR} --receipt ${EVIDENCE_PERFORMANCE_RECEIPT}`,
      },
      importer_closure_contract: {
        receipt: EVIDENCE_IMPORTER_RECEIPT,
        receipt_sha256: EVIDENCE_IMPORTER_RECEIPT_SHA256,
        subject_commit: EVIDENCE_BASE,
        subject_tree: EVIDENCE_BASE_TREE,
        predecessor_files: 54,
        predecessor_loc: 29_441,
        all_edges: 209,
        internal_deleted_importers: 42,
        internal_edges: 146,
        surviving_direct_importers: 15,
        surviving_edges: 63,
        transfers: 13,
        surface_only_callers: 1,
        unexpected_direct_importers: 0,
        activation_state: 'contract_only_implementation_not_started',
      },
      activation: {
        issue: EVIDENCE_ISSUE,
        owner_approval: EVIDENCE_OWNER_APPROVAL,
        rfc_amendment: EVIDENCE_RFC_AMENDMENT,
        performance_amendment: EVIDENCE_PERFORMANCE_AMENDMENT,
        performance_rfc_amendment: EVIDENCE_PERFORMANCE_RFC_AMENDMENT,
        authenticated_source_amendment: EVIDENCE_SOURCE_AMENDMENT,
        authenticated_source_rfc_amendment: EVIDENCE_SOURCE_RFC_AMENDMENT,
        authenticated_source_owner_approval: EVIDENCE_SOURCE_OWNER_APPROVAL,
        authenticated_source_rfc_approval: EVIDENCE_SOURCE_RFC_APPROVAL,
        protected_base: EVIDENCE_BASE,
        implementation_started: false,
      },
    })
    expect(evidence?.deterministic_query_contract)
      .not.toHaveProperty('identical_question_and_graph_bytes_are_byte_deterministic')
    expect(evidence?.deterministic_query_contract)
      .not.toHaveProperty('graph_backed_evidence_only')
    expect(Object.keys(evidence?.deterministic_query_contract ?? {}).sort()).toEqual([
      'authenticated_source_excerpt',
      'closure_pass_max',
      'determinism_inputs',
      'disconnected_boundaries_explicit',
      'duplicate_evidence_forbidden',
      'global_confidence_score',
      'graph_authoritative_for_selection_and_graph_facts',
      'hidden_second_query_or_model_call',
      'missing_and_unsupported_boundaries_explicit',
      'planner_or_recursive_recovery',
      'preserve_typed_directional_relationships',
      'repository_specific_rules',
      'stale_unavailable_corrupt_and_truncated_boundaries_explicit',
    ].sort())
    expect(Object.keys(evidence?.deterministic_query_contract?.authenticated_source_excerpt ?? {}).sort()).toEqual([
      'excerpt',
      'graph_fields_required',
      'hash_algorithm',
      'hash_mismatch_or_invalid_range',
      'hash_must_equal',
      'missing_unreadable_or_escape',
      'source_layer',
      'source_path_must_remain_beneath_root',
      'source_root',
      'unauthenticated_or_synthesized_snippet',
    ].sort())
    expect(Object.keys(evidence?.retrieve_input_contract ?? {}).sort()).toEqual([
      'additional_properties',
      'allowed_keys',
      'budget',
      'forbidden_legacy_controls',
      'question',
    ].sort())
    expect(Object.keys(evidence?.surviving_caller_contract ?? {}).sort()).toEqual([
      'compare_legacy_response_branches',
      'compatibility_types_or_engine',
      'heldout_and_performance_runners',
      'installer_applicability_hook_generation',
    ].sort())

    const absorbed = (evidence?.absorbs ?? []).map((id) => manifest.items.find((item) => item.id === id))
    expect(absorbed).toHaveLength(2)
    expect(absorbed.every(Boolean)).toBe(true)
    expect(absorbed.map((item) => ({ id: item?.id, status: item?.status, absorbed_by: item?.absorbed_by })))
      .toEqual([
        { id: 'context-governance-stack', status: 'planned', absorbed_by: 'evidence-path-query' },
        { id: 'derived-product-wrappers', status: 'planned', absorbed_by: 'evidence-path-query' },
      ])
    expect(manifest.items.find((item) => item.id === 'thin-delivery')).toMatchObject({
      status: 'proposed',
      blocked_by: 'evidence-path-query',
    })

    const evidenceOwners = [evidence, ...absorbed].filter((item): item is NonNullable<typeof item> => item !== undefined)
    const baseFiles = productionTypeScriptFilesAtCommit(EVIDENCE_BASE)
    const predecessors = baseFiles.filter((file) => evidenceOwners.some((item) =>
      (item.sources ?? []).some((pattern) => manifestGlob(pattern).test(file))))
    expect(predecessors).toHaveLength(54)
    expect(logicalLocAtCommit(EVIDENCE_BASE, predecessors)).toBe(29_441)
    for (const predecessor of predecessors) {
      expect(evidenceOwners.filter((item) =>
        (item.sources ?? []).some((pattern) => manifestGlob(pattern).test(predecessor))))
        .toHaveLength(1)
    }
    expect(EVIDENCE_REPLACEMENTS.every((path) => !baseFiles.includes(path))).toBe(true)
    expect(EVIDENCE_REPLACEMENTS.every((path) => !existsSync(resolve(path)))).toBe(true)
    expect(existsSync(resolve(EVIDENCE_PERFORMANCE_RECEIPT))).toBe(false)
    expect(productionSourceDelta(EVIDENCE_BASE)).toEqual({ added: 0, removed: 0, net: 0 })
    expect(execFileSync(
      git,
      ['diff', '--name-only', EVIDENCE_BASE, 'HEAD', '--', 'src', 'package.json', 'package-lock.json'],
      { encoding: 'utf8' },
    ).trim()).toBe('')
    expect(manifest.review).toMatchObject({ disposition_changes: 6 })
    expect(manifest.review.amendment).toContain('proof-report.ts plus review-compare.ts from move to delete')
  })

  it('pins the frozen held-out and performance contracts byte for byte', () => {
    for (const [path, expectedSha256] of Object.entries(FROZEN_EVIDENCE_HASHES)) {
      expect(gitBlobSha256('HEAD', path), `${path} must remain byte-frozen`).toBe(expectedSha256)
    }
    expect(gitBlobSha256('HEAD', EVIDENCE_PERFORMANCE_DESCRIPTOR)).toBe(EVIDENCE_PERFORMANCE_DESCRIPTOR_SHA256)

    const descriptor = JSON.parse(read(EVIDENCE_PERFORMANCE_DESCRIPTOR)) as {
      schema_version: number
      fixture_id: string
      generator: {
        algorithm: string
        seed: string
        component_count: number
        nodes_per_component: number
        node_count: number
        edge_count: number
        node_id: string
        node_label: string
        source_file: string
        source_domain: string
        phases: string[]
        phase_rule: string
        line_number_rule: string
        snippet_rule: string
        edges: Array<{
          count_per_component: number
          from: string
          to: string
          relation_rule: string
        }>
        serialization: string
      }
      queries: string[]
      query_expectations: Array<{
        query_index: number
        outcome: 'evidence' | 'missing'
        node_ids: string[]
        relationships: Array<{ from_id: string; relation: 'calls' | 'depends_on'; to_id: string }>
        boundaries: Array<{ kind: 'missing'; subject: string }>
      }>
      protocol: {
        graph_loaded_before_timer: boolean
        correctness: {
          untimed_preflight_invocations_per_query: number
          preflight_must_pass_before_warmup: boolean
          every_warmup_and_measured_result_must_match: boolean
          outcome_match: string
          node_match: string
          relationship_match: string
          boundary_match: string
          empty_positive_result: string
        }
        warmup_invocations: number
        measured_invocations: number
        query_schedule: string
        clock: string
        percentile: string
        process_model: string
        closure_pass_max: number
        selected_file_max: number
        snippet_max: number
        serialized_token_max: number
        p95_ms_max: number
      }
      reference_environment: {
        node: string
        platform: string
        release: string
        arch: string
        cpu: string
        memory_bytes: number
      }
      runner: string
      receipt: string
    }

    expect(descriptor).toMatchObject({
      schema_version: 1,
      fixture_id: 'evidence-path-performance-v1',
      generator: {
        algorithm: 'component-ring-with-fixed-skip-v1',
        seed: 'sha256-counter-v1:evidence-path-performance-v1',
        component_count: 150,
        nodes_per_component: 100,
        node_count: 15_000,
        edge_count: 30_000,
        node_id: 'n plus zero-padded global index width 5',
        node_label: 'flow plus zero-padded component width 3 plus phase plus zero-padded local index width 2',
        source_file: 'src/fixture/flow-{component}/node-{local}.ts',
        source_domain: 'production',
        phases: ['route', 'service', 'queue', 'worker', 'storage'],
        phase_rule: 'phases[local_index modulo 5]',
        line_number_rule: 'local_index plus 1',
        snippet_rule: "export function {label}() { return '{component}:{phase}:{local}'; }",
        edges: [
          {
            count_per_component: 100,
            from: 'local_index',
            to: '(local_index + 1) modulo 100',
            relation_rule: 'calls',
          },
          {
            count_per_component: 100,
            from: 'local_index',
            to: '(local_index + 37) modulo 100',
            relation_rule: 'depends_on',
          },
        ],
        serialization: 'RFC 8785 JSON Canonicalization Scheme',
      },
      queries: [
        'Trace flow-007 from route local 00 through service local 01, queue local 02, worker local 03, to storage local 04.',
        'Trace flow-042 from queue local 02 through its depends_on edge to storage local 39, then the calls edge to route local 40.',
        'Trace the calls boundary from queue local 52 to worker local 53 in flow-113.',
        'Trace the wraparound calls edge from storage local 99 to route local 00 in flow-128.',
        'Which evidence path implements flow-999?',
      ],
      query_expectations: [
        {
          query_index: 0,
          outcome: 'evidence',
          node_ids: ['n00700', 'n00701', 'n00702', 'n00703', 'n00704'],
          relationships: [
            { from_id: 'n00700', relation: 'calls', to_id: 'n00701' },
            { from_id: 'n00701', relation: 'calls', to_id: 'n00702' },
            { from_id: 'n00702', relation: 'calls', to_id: 'n00703' },
            { from_id: 'n00703', relation: 'calls', to_id: 'n00704' },
          ],
          boundaries: [],
        },
        {
          query_index: 1,
          outcome: 'evidence',
          node_ids: ['n04202', 'n04239', 'n04240'],
          relationships: [
            { from_id: 'n04202', relation: 'depends_on', to_id: 'n04239' },
            { from_id: 'n04239', relation: 'calls', to_id: 'n04240' },
          ],
          boundaries: [],
        },
        {
          query_index: 2,
          outcome: 'evidence',
          node_ids: ['n11352', 'n11353'],
          relationships: [{ from_id: 'n11352', relation: 'calls', to_id: 'n11353' }],
          boundaries: [],
        },
        {
          query_index: 3,
          outcome: 'evidence',
          node_ids: ['n12899', 'n12800'],
          relationships: [{ from_id: 'n12899', relation: 'calls', to_id: 'n12800' }],
          boundaries: [],
        },
        {
          query_index: 4,
          outcome: 'missing',
          node_ids: [],
          relationships: [],
          boundaries: [{ kind: 'missing', subject: 'flow-999' }],
        },
      ],
      protocol: {
        graph_loaded_before_timer: true,
        correctness: {
          untimed_preflight_invocations_per_query: 1,
          preflight_must_pass_before_warmup: true,
          every_warmup_and_measured_result_must_match: true,
          outcome_match: 'exact',
          node_match: 'exact_set',
          relationship_match: 'exact_directed_typed_set',
          boundary_match: 'exact_set',
          empty_positive_result: 'fail',
        },
        warmup_invocations: 3,
        measured_invocations: 20,
        query_schedule: 'queries[index modulo 5]',
        clock: 'node:perf_hooks performance.now',
        percentile: 'nearest-rank p95 over the 20 elapsed_ms samples',
        process_model: 'one Node process; one parsed graph reused by all invocations',
        closure_pass_max: 1,
        selected_file_max: 12,
        snippet_max: 25,
        serialized_token_max: 4_000,
        p95_ms_max: 500,
      },
      reference_environment: {
        node: 'v22.9.0',
        platform: 'darwin',
        release: '25.3.0',
        arch: 'arm64',
        cpu: 'Apple M3 Max',
        memory_bytes: 51_539_607_552,
      },
      runner: `node tools/eval/core-reset/evidence-path-performance.mjs --contract ${EVIDENCE_PERFORMANCE_DESCRIPTOR} --receipt ${EVIDENCE_PERFORMANCE_RECEIPT}`,
      receipt: EVIDENCE_PERFORMANCE_RECEIPT,
    })
    expect(descriptor.generator.component_count * descriptor.generator.nodes_per_component)
      .toBe(descriptor.generator.node_count)
    expect(
      descriptor.generator.component_count
      * descriptor.generator.edges.reduce((total, edge) => total + edge.count_per_component, 0),
    ).toBe(descriptor.generator.edge_count)
    expect(descriptor.queries).toHaveLength(5)
    expect(descriptor.query_expectations.map((entry) => entry.query_index)).toEqual([0, 1, 2, 3, 4])
    expect(descriptor.query_expectations.filter((entry) => entry.outcome === 'evidence')).toHaveLength(4)
    expect(descriptor.query_expectations.filter((entry) => entry.outcome === 'missing')).toHaveLength(1)

    const coordinates = (nodeId: string): { component: number; local: number } => {
      const match = /^n(\d{3})(\d{2})$/.exec(nodeId)
      if (!match) throw new Error(`invalid performance fixture node id: ${nodeId}`)
      return { component: Number(match[1]), local: Number(match[2]) }
    }
    for (const expectation of descriptor.query_expectations) {
      expect(expectation.query_index).toBeLessThan(descriptor.queries.length)
      if (expectation.outcome === 'missing') {
        expect(expectation).toEqual({
          query_index: 4,
          outcome: 'missing',
          node_ids: [],
          relationships: [],
          boundaries: [{ kind: 'missing', subject: 'flow-999' }],
        })
        continue
      }

      expect(expectation.node_ids.length).toBeGreaterThan(0)
      expect(expectation.relationships.length).toBeGreaterThan(0)
      expect(expectation.boundaries).toEqual([])
      const selectedNodes = new Set(expectation.node_ids)
      for (const nodeId of selectedNodes) {
        const node = coordinates(nodeId)
        expect(node.component).toBeLessThan(descriptor.generator.component_count)
        expect(node.local).toBeLessThan(descriptor.generator.nodes_per_component)
      }
      for (const relationship of expectation.relationships) {
        expect(selectedNodes.has(relationship.from_id)).toBe(true)
        expect(selectedNodes.has(relationship.to_id)).toBe(true)
        const from = coordinates(relationship.from_id)
        const to = coordinates(relationship.to_id)
        expect(to.component).toBe(from.component)
        const offset = relationship.relation === 'calls' ? 1 : 37
        expect(to.local).toBe((from.local + offset) % descriptor.generator.nodes_per_component)
      }
    }
    expect(existsSync(resolve(EVIDENCE_PERFORMANCE_RECEIPT))).toBe(false)
  })

  it('binds the evidence-path importer closure to protected-base Git content', () => {
    expect(gitBlobSha256('HEAD', EVIDENCE_IMPORTER_RECEIPT)).toBe(EVIDENCE_IMPORTER_RECEIPT_SHA256)
    const receipt = JSON.parse(read(EVIDENCE_IMPORTER_RECEIPT)) as {
      schema_version: number
      receipt_kind: string
      issue: string
      subject: { commit: string; tree: string }
      method: { source_inventory: string; logical_loc: string; imports: string; scope: string }
      production: {
        predecessor_files: number
        predecessor_loc: number
        categories: Array<{ id: string; files: number; loc: number; paths: string[] }>
      }
      ownership: {
        absorbed_handles: string[]
        transfers: Array<{ path: string; from: string; to: string }>
        disposition_changes_from_baseline: number
        new_disposition_changes: Array<{ path: string; from: string; to: string }>
      }
      importer_closure: {
        edge_encoding: string
        all_edge_count: number
        all_edge_sha256: string
        internal_deleted_importer_count: number
        internal_edge_count: number
        internal_edge_sha256: string
        surviving_direct_importer_count: number
        surviving_edge_count: number
        surviving_edge_sha256: string
        surviving_direct_importers: Array<{ path: string; targets: string[] }>
        surface_only: Array<{ path: string; reason: string }>
        explicit_surviving_callsite_scope: Array<{ path: string; action: string }>
        unexpected_direct_importers: string[]
      }
      replacement: {
        production_files_max: number
        production_loc_added_max: number
        paths: string[]
        optional_peer_metadata_removed: string
      }
      activation_state: string
    }

    expect(receipt).toMatchObject({
      schema_version: 1,
      receipt_kind: 'core-reset-evidence-path-importer-closure',
      issue: EVIDENCE_ISSUE,
      subject: { commit: EVIDENCE_BASE, tree: EVIDENCE_BASE_TREE },
      method: {
        source_inventory: 'git ls-tree at the protected commit',
        logical_loc: 'LF count plus a final non-LF line',
        imports: 'TypeScript AST static import, re-export, dynamic import, import-equals, and require scan with repository-relative .js-to-.ts resolution',
      },
      production: { predecessor_files: 54, predecessor_loc: 29_441 },
      ownership: {
        absorbed_handles: ['context-governance-stack', 'derived-product-wrappers'],
        disposition_changes_from_baseline: 6,
        new_disposition_changes: [
          { path: 'src/infrastructure/proof-report.ts', from: 'move', to: 'delete' },
          { path: 'src/infrastructure/review-compare.ts', from: 'move', to: 'delete' },
        ],
      },
      importer_closure: {
        edge_encoding: 'sorted unique UTF-8 rows of importer + NUL + target + LF, including a final LF',
        all_edge_count: 209,
        all_edge_sha256: '81cea60597f514970d1f30015de70ba66bbf49a0cc4ef921bcfe7588609bbbe8',
        internal_deleted_importer_count: 42,
        internal_edge_count: 146,
        internal_edge_sha256: '4e4ee17990fdeaba0ca8fc4985b791a30499057bd530eb3b95e6870c9e98c85d',
        surviving_direct_importer_count: 15,
        surviving_edge_count: 63,
        surviving_edge_sha256: '2ff971232ddf5942db1d8ce0b90c484d6f7945577766d92920c5aedc8c7e3a59',
        surface_only: [{
          path: 'src/runtime/stdio/definitions.ts',
          reason: 'declares the retired MCP schemas without importing a predecessor',
        }],
        unexpected_direct_importers: [],
      },
      replacement: {
        production_files_max: 7,
        production_loc_added_max: 3_500,
        paths: [...EVIDENCE_REPLACEMENTS],
        optional_peer_metadata_removed: '@huggingface/transformers',
      },
      activation_state: 'contract_only_implementation_not_started',
    })

    const categories = receipt.production.categories
    expect(categories.map(({ id, files, loc }) => ({ id, files, loc }))).toEqual([
      { id: 'query', files: 11, loc: 12_535 },
      { id: 'context-governance-stack', files: 26, loc: 6_538 },
      { id: 'derived-product-wrappers', files: 7, loc: 4_064 },
      { id: 'semantic', files: 1, loc: 368 },
      { id: 'importer-only-surfaces', files: 9, loc: 5_936 },
    ])
    const deletionFiles = categories.flatMap((category) => category.paths)
    expect(new Set(deletionFiles).size).toBe(54)
    expect(logicalLocAtCommit(EVIDENCE_BASE, deletionFiles)).toBe(29_441)
    for (const category of categories) {
      expect(category.paths).toHaveLength(category.files)
      expect(logicalLocAtCommit(EVIDENCE_BASE, category.paths)).toBe(category.loc)
    }

    const deletionFileSet = new Set(deletionFiles)
    const edges = deletionImportEdgesAtCommit(EVIDENCE_BASE, deletionFileSet)
    expect(edges).toMatchObject({
      all: expect.arrayContaining(['src/runtime/retrieve.ts\0src/runtime/semantic.ts']),
    })
    expect({
      all_edge_count: edges.all.length,
      all_edge_sha256: edgeListSha256(edges.all),
      internal_deleted_importer_count: new Set(edges.internal.map((edge) => edge.slice(0, edge.indexOf('\0')))).size,
      internal_edge_count: edges.internal.length,
      internal_edge_sha256: edgeListSha256(edges.internal),
      surviving_direct_importer_count: new Set(edges.surviving.map((edge) => edge.slice(0, edge.indexOf('\0')))).size,
      surviving_edge_count: edges.surviving.length,
      surviving_edge_sha256: edgeListSha256(edges.surviving),
    }).toEqual({
      all_edge_count: receipt.importer_closure.all_edge_count,
      all_edge_sha256: receipt.importer_closure.all_edge_sha256,
      internal_deleted_importer_count: receipt.importer_closure.internal_deleted_importer_count,
      internal_edge_count: receipt.importer_closure.internal_edge_count,
      internal_edge_sha256: receipt.importer_closure.internal_edge_sha256,
      surviving_direct_importer_count: receipt.importer_closure.surviving_direct_importer_count,
      surviving_edge_count: receipt.importer_closure.surviving_edge_count,
      surviving_edge_sha256: receipt.importer_closure.surviving_edge_sha256,
    })

    const observedSurvivingImporters = [...new Set(edges.surviving.map((edge) => edge.slice(0, edge.indexOf('\0'))))]
      .sort()
      .map((path) => ({
        path,
        targets: edges.surviving
          .filter((edge) => edge.startsWith(`${path}\0`))
          .map((edge) => edge.slice(edge.indexOf('\0') + 1)),
      }))
    expect(receipt.importer_closure.surviving_direct_importers).toEqual(observedSurvivingImporters)
    expect(receipt.ownership.transfers.map((transfer) => transfer.path)).toEqual([...EVIDENCE_TRANSFERS])
    expect(receipt.ownership.transfers.every((transfer) => transfer.to === 'evidence-path-query')).toBe(true)
    expect(receipt.importer_closure.explicit_surviving_callsite_scope.map((entry) => entry.path).sort())
      .toEqual([
        ...observedSurvivingImporters.map((entry) => entry.path),
        'src/runtime/stdio/definitions.ts',
      ].sort())
    expect(EVIDENCE_REPLACEMENTS.every((path) => !existsSync(resolve(path)))).toBe(true)
  })

  it('publishes an exact hermetic generation mutation receipt', () => {
    expect(gitBlobSha256('HEAD', INCREMENTAL_MUTATION_RECEIPT)).toBe(INCREMENTAL_MUTATION_RECEIPT_SHA256)
    expect(gitBlobSha256(EVIDENCE_BASE, INCREMENTAL_MUTATION_RECEIPT)).toBe(
      INCREMENTAL_MUTATION_RECEIPT_SHA256,
    )
    const receipt = JSON.parse(read(INCREMENTAL_MUTATION_RECEIPT)) as {
      schema_version: number
      receipt_kind: string
      status: string
      issue: string
      pull_request: string
      subject: {
        protected_base: string
        implementation_commit: string
        final_pr_head: string
        ci_head: string
        merge_commit: string
        final_and_merge_tree: string
        runtime_source_or_package_drift_after_implementation: boolean
      }
      verification: {
        command: string
        test_files_passed: number
        tests_passed: number
        tests_failed: number
        ci_run: string
        ci_matrix_jobs_passed: number
      }
      test_files: Array<{ path: string; sha256: string }>
      mutation_cases: string[]
      publication_and_concurrency_cases: string[]
      equivalence_contract: {
        update_equals_clean_generation: boolean
        authoritative_graph_bytes_equal: boolean
        derived_diagnostics_equal_except_generated_at: boolean
        deterministic_build_id_equal: boolean
        zero_stale_nodes_or_edges_after_delete_or_rename: boolean
        graph_commits_last: boolean
        maximum_concurrent_builders: number
      }
    }

    expect(receipt).toMatchObject({
      schema_version: 1,
      receipt_kind: 'core-reset-generation-mutation-equivalence',
      status: 'passed',
      issue: 'https://github.com/mohanagy/madar/issues/592',
      pull_request: 'https://github.com/mohanagy/madar/pull/594',
      subject: {
        protected_base: INCREMENTAL_BASE,
        implementation_commit: INCREMENTAL_IMPLEMENTATION,
        final_pr_head: INCREMENTAL_CI_HEAD,
        ci_head: INCREMENTAL_CI_HEAD,
        merge_commit: INCREMENTAL_MERGE,
        final_and_merge_tree: INCREMENTAL_FINAL_TREE,
        runtime_source_or_package_drift_after_implementation: false,
      },
      verification: {
        test_files_passed: 5,
        tests_passed: 92,
        tests_failed: 0,
        ci_run: INCREMENTAL_CI_RUN,
        ci_matrix_jobs_passed: 6,
      },
      equivalence_contract: {
        update_equals_clean_generation: true,
        authoritative_graph_bytes_equal: true,
        derived_diagnostics_equal_except_generated_at: true,
        deterministic_build_id_equal: true,
        zero_stale_nodes_or_edges_after_delete_or_rename: true,
        graph_commits_last: true,
        maximum_concurrent_builders: 1,
      },
    })
    expect(receipt.verification.command).toContain('tests/unit/update-index.test.ts')
    expect(receipt.mutation_cases).toEqual(expect.arrayContaining([
      'cold_no_op',
      'add_and_import',
      'private_leaf_change',
      'exported_signature_change',
      'delete_with_zero_stale_facts',
      'rename_with_zero_stale_facts',
      'compiler_control_change',
      'madarignore_add_change_delete',
      'gitignore_respected_and_ignored',
      'recognized_unsupported_add_delete_rename',
      'allowed_symlink_add_retarget_delete',
      'linked_worktree_isolation',
    ]))
    expect(receipt.publication_and_concurrency_cases).toEqual(expect.arrayContaining([
      'first_graph_commit_failure',
      'replacement_graph_commit_failure',
      'derived_diagnostic_failure',
      'source_edit_at_commit_boundary',
      'edit_during_build_follow_up',
      'concurrent_controller_serialization',
    ]))
    expect(receipt.test_files).toHaveLength(5)
    for (const file of receipt.test_files) {
      const recordedTest = execFileSync(git, ['show', `${receipt.subject.merge_commit}:${file.path}`])
      expect(createHash('sha256').update(recordedTest).digest('hex')).toBe(file.sha256)
    }
    expect(execFileSync(git, ['show', '-s', '--format=%T', receipt.subject.merge_commit], { encoding: 'utf8' }).trim())
      .toBe(INCREMENTAL_FINAL_TREE)
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
      npm_files: 276,
      npm_packed_bytes: 572_143,
      npm_unpacked_bytes: 2_699_851,
    })
  })

  it('records the simplified implementation without retaining the failed warm path', () => {
    expect(productionSourceDelta(INCREMENTAL_BASE)).toEqual({ added: 2_190, removed: 4_726, net: -2_536 })
    expect(execFileSync(git, ['rev-parse', `${INCREMENTAL_MERGE}^{tree}`], { encoding: 'utf8' }).trim())
      .toBe(INCREMENTAL_FINAL_TREE)
    expect(execFileSync(
      git,
      ['diff', '--name-only', INCREMENTAL_MERGE, 'HEAD', '--', 'src', 'package.json', 'package-lock.json'],
      { encoding: 'utf8' },
    ).trim()).toBe('')
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
        loc_added: 2_190,
        loc_removed: 4_726,
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
        packed_bytes: 572_143,
        unpacked_bytes: 2_699_851,
        shasum: '93b79f9d81f193af3c3d6e45159eae56fc9523a9',
        integrity: 'sha512-7BNI5MBA92VWPpY0/CzZ2feSYRc+kCUcUw5IIpLdg2rqRCtEANIMgmkBFXI0L7NufrpbVTc7xfBr6rWRtNijmg==',
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
      receipt_sha256: '4b64f83dabcab80a3e60e35ada275c4852c32e549a0586c905d6f375534836b4',
      subject: {
        head_commit: INCREMENTAL_IMPLEMENTATION,
        dirty: false,
        head_tree_oid: '3d8ad953b47a06e211e54958c8c8d194d5a2d999',
        worktree_tree_oid: '3d8ad953b47a06e211e54958c8c8d194d5a2d999',
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
        cold_noop_p50_ratio: { actual: 0.067, pass: true },
        cold_noop_zero_parse: { pass: true },
        clean_generation_regression: { baseline_compatible: true, ratio: 1.045, pass: true },
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
    expect(evidencePath?.transferred_sources).toEqual([...EVIDENCE_TRANSFERS])
    expect(evidencePath?.preserve).toEqual([
      'SourceDomain',
      'classifySourceDomain',
      'isPollutedSourcePath',
      'private helpers required only by those query-classification exports',
    ])
    expect(thinDelivery?.transferred_sources).toEqual(['src/infrastructure/doctor.ts'])
    expect(evidencePath?.status).toBe('in_progress')
    expect(thinDelivery?.status).toBe('proposed')
    for (const completedId of [
      'directed-multigraph',
      'canonical-typescript-index',
      'legacy-extraction',
      'generation-and-incremental',
    ]) {
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
      disposition_changes: 6,
    })
    expect(manifest.review.amendment).toContain('Approved issue #596 absorbs')
    expect(manifest.review.amendment).toContain('proof-report.ts plus review-compare.ts from move to delete')
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
    expect(governance).toContain('Evidence-path query is the sole technical phase In progress')
    expect(governance).toContain('## In progress — evidence-path query')
    expect(governance).not.toContain('## In progress — generation and incremental index')
    expect(governance).not.toContain('single In progress phase through #592')
    expect(governance).not.toContain('phase completion awaits')
    expect(governance).not.toContain('completion evidence remains open')
    expect(governance).not.toContain('scope and baseline is the only authorized phase')
  })
})
