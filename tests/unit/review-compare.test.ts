import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  executeReviewCompareRuns,
  formatReviewCompareSummary,
  generateReviewCompareArtifacts,
  type ReviewCompareReport,
} from '../../src/infrastructure/review-compare.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'

function createRepo(options: { pathLikeNodeIds?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'graphify-ts-review-compare-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'tests'), { recursive: true })
  mkdirSync(join(root, 'graphify-out'), { recursive: true })
  const authNodeId = options.pathLikeNodeIds
    ? 'users_testuser_desktop_projects_demo_src_auth_ts_authenticateuser'
    : 'auth_user'
  const apiNodeId = options.pathLikeNodeIds
    ? 'users_testuser_desktop_projects_demo_src_api_ts_apihandler'
    : 'api_handler'
  const auditNodeId = options.pathLikeNodeIds
    ? 'users_testuser_desktop_projects_demo_src_audit_log_ts_appendauthaudit'
    : 'audit_logger'

  writeFileSync(join(root, 'src', 'auth.ts'), [
    'export function authenticateUser(token: string) {',
    '  const parsed = token.trim()',
    '  const status = "ok"',
    '  return parsed.length > 0 ? status : "fail"',
    '}',
    '',
  ].join('\n'), 'utf8')
  writeFileSync(join(root, 'src', 'api.ts'), [
    'export function ApiHandler(token: string) {',
    '  return authenticateUser(token)',
    '}',
    '',
  ].join('\n'), 'utf8')
  writeFileSync(join(root, 'src', 'audit-log.ts'), [
    'export function appendAuthAudit(actor: string, status: string) {',
    '  return `${actor}:${status}`.toLowerCase()',
    '}',
    '',
  ].join('\n'), 'utf8')
  writeFileSync(join(root, 'tests', 'auth.test.ts'), 'describe("auth", () => {})\n', 'utf8')

  writeFileSync(
    join(root, 'graphify-out', 'graph.json'),
    JSON.stringify({
      directed: true,
      community_labels: {
        '0': 'Auth Layer',
        '1': 'API Layer',
        '2': 'Audit Trail',
      },
      nodes: [
        {
          id: authNodeId,
          label: 'authenticateUser',
          source_file: join(root, 'src', 'auth.ts'),
          source_location: 'L1-L5',
          node_kind: 'function',
          file_type: 'code',
          community: 0,
        },
        {
          id: apiNodeId,
          label: 'ApiHandler',
          source_file: join(root, 'src', 'api.ts'),
          source_location: 'L1-L3',
          node_kind: 'function',
          file_type: 'code',
          community: 1,
        },
        {
          id: auditNodeId,
          label: 'appendAuthAudit',
          source_file: join(root, 'src', 'audit-log.ts'),
          source_location: 'L1-L3',
          node_kind: 'function',
          file_type: 'code',
          community: 2,
        },
      ],
      edges: [
        {
          source: apiNodeId,
          target: authNodeId,
          relation: 'calls',
          confidence: 'EXTRACTED',
          source_file: join(root, 'src', 'api.ts'),
        },
        {
          source: authNodeId,
          target: auditNodeId,
          relation: 'calls',
          confidence: 'EXTRACTED',
          source_file: join(root, 'src', 'auth.ts'),
        },
      ],
      hyperedges: [],
      root_path: root,
    }),
    'utf8',
  )

  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'graphify@example.com'], { cwd: root, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.name', 'Graphify Test'], { cwd: root, stdio: 'pipe' })
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: root, stdio: 'pipe' })
  writeFileSync(
    join(root, 'src', 'auth.ts'),
    [
      'export function authenticateUser(token: string) {',
      '  const parsed = token.trim()',
      '  const status = token.startsWith("Bearer ") ? "ok" : "fail"',
      '  return parsed.length > 0 ? status : "fail"',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )

  return root
}

describe('review compare', () => {
  const repoRoots: string[] = []

  afterEach(() => {
    for (const root of repoRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('writes verbose and compact review prompt artifacts with reduction metrics', () => {
    const root = createRepo()
    repoRoots.push(root)

    const result = generateReviewCompareArtifacts({
      graphPath: join(root, 'graphify-out', 'graph.json'),
      outputDir: join(root, 'graphify-out', 'review-compare'),
      execTemplate: 'claude -p "$(cat {prompt_file})"',
      now: new Date('2026-05-01T21:00:00.000Z'),
    })

    const verbosePrompt = readFileSync(result.report.paths.verbose_prompt, 'utf8')
    const compactPrompt = readFileSync(result.report.paths.compact_prompt, 'utf8')

    expect(result.report.changed_files).toEqual(['src/auth.ts'])
    expect(result.report.seed_count).toBe(1)
    expect(result.report.verbose_payload_tokens).toBeGreaterThan(result.report.compact_payload_tokens)
    expect(result.report.verbose_prompt_tokens).toBe(estimateQueryTokens(verbosePrompt))
    expect(result.report.compact_prompt_tokens).toBe(estimateQueryTokens(compactPrompt))
    expect(result.report.reduction_ratio).toBeGreaterThan(1)
    expect(result.report.verbose_effective_prompt_tokens).toBe(result.report.verbose_prompt_tokens)
    expect(result.report.compact_effective_prompt_tokens).toBe(result.report.compact_prompt_tokens)
    expect(result.report.effective_reduction_ratio).toBe(result.report.reduction_ratio)
    expect(result.report.provider_proof).toEqual({
      verbose: {
        input_tokens_source: 'estimated_cl100k_base',
        effective_tokens_source: 'session_reuse_estimate',
        total_tokens_source: 'not_available',
      },
      compact: {
        input_tokens_source: 'estimated_cl100k_base',
        effective_tokens_source: 'session_reuse_estimate',
        total_tokens_source: 'not_available',
      },
      reduction_basis: 'estimated',
    })
    expect(verbosePrompt).toContain('"changed_files"')
    expect(compactPrompt).toContain('"review_context"')
    expect(compactPrompt).toContain('"supporting_paths"')
    expect(verbosePrompt.indexOf('Mode: verbose')).toBeGreaterThan(verbosePrompt.indexOf('"changed_files"'))
    expect(compactPrompt.indexOf('Mode: compact')).toBeGreaterThan(compactPrompt.indexOf('"review_context"'))
    expect(formatReviewCompareSummary(result)).toContain('Effective prompt tokens')
    expect(formatReviewCompareSummary(result)).toContain('Provider/runtime proof: local cl100k_base estimate + session reuse accounting')
  })

  it('uses the shared review prompt helper instead of duplicating buildContextPrompt calls inline', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'infrastructure', 'review-compare.ts'), 'utf8')
    const functionStart = source.indexOf('export function generateReviewCompareArtifacts')
    const functionEnd = source.indexOf('const paths: ReviewComparePromptArtifactPaths', functionStart)
    const functionBody = source.slice(functionStart, functionEnd)

    expect(functionBody).toContain('renderReviewPrompt(')
    expect(functionBody).not.toContain('buildContextPrompt(')
  })

  it('allows nested output directories whose parent does not exist yet', () => {
    const root = createRepo()
    repoRoots.push(root)

    const result = generateReviewCompareArtifacts({
      graphPath: join(root, 'graphify-out', 'graph.json'),
      outputDir: join(root, 'graphify-out', 'review-compare', 'session1'),
      execTemplate: 'claude -p "$(cat {prompt_file})"',
      now: new Date('2026-05-01T21:00:00.000Z'),
    })

    expect(result.report.paths.output_dir).toContain(join('review-compare', 'session1'))
    expect(readFileSync(result.report.paths.verbose_prompt, 'utf8')).toContain('"changed_files"')
    expect(readFileSync(result.report.paths.compact_prompt, 'utf8')).toContain('"review_context"')
  })

  it('writes a companion share-safe report without changing the local report contract', () => {
    const root = createRepo()
    repoRoots.push(root)

    const result = generateReviewCompareArtifacts({
      graphPath: join(root, 'graphify-out', 'graph.json'),
      outputDir: join(root, 'graphify-out', 'review-compare'),
      execTemplate: 'claude -p "$(cat {prompt_file})"',
      now: new Date('2026-05-01T21:00:00.000Z'),
    })

    const localReport = JSON.parse(readFileSync(result.report.paths.report, 'utf8')) as Record<string, unknown>
    const shareSafePath = join(result.report.paths.output_dir, 'report.share-safe.json')
    const shareSafeReport = JSON.parse(readFileSync(shareSafePath, 'utf8')) as Record<string, unknown>

    expect(localReport).toEqual(
      expect.objectContaining({
        graph_path: expect.stringContaining('graphify-out/graph.json'),
        paths: expect.objectContaining({
          report: expect.stringContaining('report.json'),
        }),
      }),
    )
    expect(shareSafeReport).toEqual(
      expect.objectContaining({
        graph_path: '<project-root>/graphify-out/graph.json',
        paths: expect.objectContaining({
          output_dir: '<artifact-root>',
          report: '<artifact-root>/report.json',
          share_safe_report: '<artifact-root>/report.share-safe.json',
        }),
      }),
    )
    expect(JSON.stringify(shareSafeReport)).not.toContain(root)
  })

  it('sanitizes path-derived node ids in persisted review prompts', () => {
    const root = createRepo({ pathLikeNodeIds: true })
    repoRoots.push(root)

    const result = generateReviewCompareArtifacts({
      graphPath: join(root, 'graphify-out', 'graph.json'),
      outputDir: join(root, 'graphify-out', 'review-compare'),
      execTemplate: 'claude -p "$(cat {prompt_file})"',
      now: new Date('2026-05-01T21:00:00.000Z'),
    })

    const verbosePrompt = readFileSync(result.report.paths.verbose_prompt, 'utf8')
    const compactPrompt = readFileSync(result.report.paths.compact_prompt, 'utf8')

    expect(verbosePrompt).not.toContain('users_testuser_desktop_projects_demo_src_auth_ts_authenticateuser')
    expect(compactPrompt).not.toContain('users_testuser_desktop_projects_demo_src_auth_ts_authenticateuser')
    expect(verbosePrompt).toMatch(/"node_id": "review_node_[0-9a-f]+"/)
    expect(compactPrompt).toMatch(/"node_id": "review_node_[0-9a-f]+"/)
  })

  it('executes review compare prompts sequentially and saves answer artifacts', async () => {
    const root = createRepo()
    repoRoots.push(root)
    const executions: Array<{ mode: string; promptFile: string; outputFile: string }> = []

    const result = await executeReviewCompareRuns(
      {
        graphPath: join(root, 'graphify-out', 'graph.json'),
        outputDir: join(root, 'graphify-out', 'review-compare'),
        execTemplate: 'runner --prompt {prompt_file} --mode {mode} --out {output_file}',
        now: new Date('2026-05-01T21:00:00.000Z'),
      },
      {
        runner: async (execution) => {
          executions.push(execution)
          return {
            exitCode: 0,
            stdout: `${execution.mode} answer\n`,
            stderr: '',
            elapsedMs: execution.mode === 'verbose' ? 15 : 9,
          }
        },
      },
    )

    expect(executions.map((execution) => execution.mode)).toEqual(['verbose', 'compact'])
    expect(readFileSync(result.report.answer_paths.verbose, 'utf8')).toBe('verbose answer\n')
    expect(readFileSync(result.report.answer_paths.compact, 'utf8')).toBe('compact answer\n')
    expect(result.report.status).toEqual({
      verbose: 'succeeded',
      compact: 'succeeded',
    })
    expect(result.report.elapsed_ms).toEqual({
      verbose: 15,
      compact: 9,
    })
    expect(formatReviewCompareSummary(result)).toContain('Prompt tokens')
  })

  it('redacts local artifact paths from share-safe stderr on failed runs', async () => {
    const root = createRepo()
    repoRoots.push(root)
    const externalAbsolutePath = process.platform === 'win32' ? 'C:\\Users\\alice\\.ssh\\config' : '/Users/alice/.ssh/config'

    const result = await executeReviewCompareRuns(
      {
        graphPath: join(root, 'graphify-out', 'graph.json'),
        outputDir: join(root, 'graphify-out', 'review-compare'),
        execTemplate: 'runner --prompt {prompt_file} --mode {mode} --out {output_file}',
        now: new Date('2026-05-01T21:00:00.000Z'),
      },
      {
        runner: async (execution) => ({
          exitCode: 1,
          stdout: '',
          stderr: [
            `prompt=${execution.promptFile}`,
            `output=${execution.outputFile}`,
            `graph=${join(root, 'graphify-out', 'graph.json')}`,
            `project=${root}`,
            `external=${externalAbsolutePath}`,
          ].join('\n'),
          elapsedMs: execution.mode === 'verbose' ? 15 : 9,
        }),
      },
    )

    const localReport = JSON.parse(readFileSync(result.report.paths.report, 'utf8')) as ReviewCompareReport
    const shareSafeRaw = readFileSync(result.report.paths.share_safe_report, 'utf8')
    const shareSafeReport = JSON.parse(shareSafeRaw) as ReviewCompareReport

    expect(localReport.stderr.verbose).toContain(`prompt=${result.report.paths.verbose_prompt}`)
    expect(localReport.stderr.verbose).toContain(`output=${result.report.answer_paths.verbose}`)
    expect(localReport.stderr.verbose).toContain(`graph=${join(root, 'graphify-out', 'graph.json')}`)
    expect(localReport.stderr.verbose).toContain(`project=${root}`)
    expect(localReport.stderr.verbose).toContain(`external=${externalAbsolutePath}`)

    expect(shareSafeReport.stderr.verbose).toContain('prompt=<artifact-root>/verbose-prompt.txt')
    expect(shareSafeReport.stderr.verbose).toContain('output=<artifact-root>/verbose-answer.txt')
    expect(shareSafeReport.stderr.verbose).toContain('graph=<project-root>/graphify-out/graph.json')
    expect(shareSafeReport.stderr.verbose).toContain('project=<project-root>')
    expect(shareSafeReport.stderr.verbose).toContain(`external=${basename(externalAbsolutePath)}`)
    expect(shareSafeReport.stderr.verbose).not.toContain(root)
    expect(shareSafeReport.stderr.verbose).not.toContain(externalAbsolutePath)
    expect(shareSafeRaw).not.toContain(externalAbsolutePath)
  })
})
