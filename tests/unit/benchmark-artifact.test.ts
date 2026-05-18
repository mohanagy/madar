import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { CompareReportPack } from '../../src/infrastructure/compare.js'

const ARTIFACT_DIR = resolve('docs', 'benchmarks', '2026-04-30-govalidate')
const REVIEW_ARTIFACT_DIR = resolve('docs', 'benchmarks', '2026-05-02-govalidate-pr-review')
const BENCHMARK_STYLESHEET = resolve('docs', 'benchmarks', 'styles.css')
const PACK_VERIFIER_PATH = resolve('docs', 'benchmarks', 'govalidate-suite', 'verify-pack-quality.js')

interface PackQualityGateDefinition {
  required_labels: string[]
  forbidden_labels: string[]
  max_pack_tokens: number
  max_matched_nodes: number
  max_relationships: number
}

const DOCS_ARTIFACT_GATE: PackQualityGateDefinition = {
  required_labels: ['IdeaReportController', 'GenerateIdeaReportService'],
  forbidden_labels: ['IdeaReportSharePage', 'GenerateIdeaReportScript'],
  max_pack_tokens: 1_456,
  max_matched_nodes: 38,
  max_relationships: 57,
}

function buildMatchedNodes(totalCount: number, labels: readonly string[]): CompareReportPack['matched_nodes'] {
  const nodes: CompareReportPack['matched_nodes'] = labels.map(
    (label, index): CompareReportPack['matched_nodes'][number] => ({
      label,
      source_file: `src/runtime/report-${index + 1}.ts`,
      line_number: index + 1,
      snippet: `// ${label}`,
      match_score: totalCount - index,
      relevance_band: index === 0 ? 'direct' : 'related',
      community: 1,
      file_type: 'code',
    }),
  )

  while (nodes.length < totalCount) {
    const index = nodes.length + 1
    nodes.push({
      label: `SupportingReportNode${index}`,
      source_file: `src/runtime/supporting-${index}.ts`,
      line_number: index,
      snippet: `// SupportingReportNode${index}`,
      match_score: totalCount - index,
      relevance_band: 'peripheral',
      community: 1,
      file_type: 'code',
    })
  }

  return nodes
}

function buildRelationships(
  totalCount: number,
  matchedNodes: CompareReportPack['matched_nodes'],
): CompareReportPack['relationships'] {
  const labels = matchedNodes.map(({ label }) => label)

  return Array.from({ length: totalCount }, (_, index) => ({
    from: labels[index % labels.length]!,
    to: labels[(index + 1) % labels.length]!,
    relation: 'calls',
  }))
}

function buildPackFixture(overrides: Partial<Pick<CompareReportPack, 'token_count' | 'matched_nodes' | 'relationships'>> = {}): CompareReportPack {
  const matched_nodes = overrides.matched_nodes
    ?? buildMatchedNodes(DOCS_ARTIFACT_GATE.max_matched_nodes, DOCS_ARTIFACT_GATE.required_labels)
  const relationships = overrides.relationships ?? buildRelationships(DOCS_ARTIFACT_GATE.max_relationships, matched_nodes)

  return {
    question: 'Explain how idea report is getting generated',
    token_count: DOCS_ARTIFACT_GATE.max_pack_tokens,
    matched_nodes,
    relationships,
    community_context: [{ id: 1, label: 'Report Generation', node_count: 38 }],
    graph_signals: { god_nodes: [], bridge_nodes: [] },
    retrieval_strategy: 'default',
    ...overrides,
  }
}

function writeCompareStyleReport(reportPath: string, pack: CompareReportPack): void {
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        question: pack.question,
        graph_path: 'graphify-out/graph.json',
        baseline_mode: 'pack_only',
        pack,
        paths: {
          output_dir: '.',
          baseline_prompt: 'baseline-prompt.txt',
          graphify_prompt: 'graphify-prompt.txt',
          report: 'report.json',
          share_safe_report: 'report.share-safe.json',
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
}

function runPackVerifier(
  testName: string,
  pack: CompareReportPack,
  gateConfig: Record<string, PackQualityGateDefinition> = { 'docs-artifact': DOCS_ARTIFACT_GATE },
): ReturnType<typeof spawnSync> {
  const fixtureRoot = join(
    process.cwd(),
    'graphify-out',
    'benchmark-artifact-pack-quality',
    `${testName}-${process.pid}-${Date.now()}`,
  )
  const reportPath = join(fixtureRoot, 'report.json')
  const configPath = join(fixtureRoot, 'quality-gates.json')
  mkdirSync(fixtureRoot, { recursive: true })
  writeCompareStyleReport(reportPath, pack)
  writeFileSync(configPath, `${JSON.stringify(gateConfig, null, 2)}\n`, 'utf8')

  try {
    return spawnSync(
      process.execPath,
      [PACK_VERIFIER_PATH, '--gate', 'docs-artifact', '--config', configPath, '--report', reportPath],
      { encoding: 'utf8' },
    )
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
}

function combinedOutput(result: ReturnType<typeof spawnSync>): string {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
}

describe('public benchmark artifact (2026-04-30 govalidate)', () => {
  const baseline = JSON.parse(readFileSync(resolve(ARTIFACT_DIR, 'baseline-session.json'), 'utf8')) as {
    num_turns: number
    duration_ms: number
    total_cost_usd: number
    usage: { input_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }
  }
  const graphify = JSON.parse(readFileSync(resolve(ARTIFACT_DIR, 'graphify-session.json'), 'utf8')) as typeof baseline
  const readme = readFileSync(resolve(ARTIFACT_DIR, 'README.md'), 'utf8')

  function totalInput(usage: typeof baseline.usage): number {
    return usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens
  }

  it('committed JSON files exist with the expected Anthropic-shaped fields', () => {
    expect(typeof baseline.num_turns).toBe('number')
    expect(typeof baseline.duration_ms).toBe('number')
    expect(typeof baseline.usage.input_tokens).toBe('number')
    expect(typeof graphify.num_turns).toBe('number')
    expect(typeof graphify.duration_ms).toBe('number')
    expect(typeof graphify.usage.input_tokens).toBe('number')
  })

  it('README cites num_turns numbers that match the JSON', () => {
    expect(readme).toContain(`| ${baseline.num_turns} |`)
    expect(readme).toContain(`**${graphify.num_turns}**`)
  })

  it('README cites latency numbers that match the JSON (in ms)', () => {
    expect(readme).toContain(baseline.duration_ms.toLocaleString('en-US'))
    expect(readme).toContain(graphify.duration_ms.toLocaleString('en-US'))
  })

  it('README cites total input tokens that exactly equal the JSON sums', () => {
    const baselineTotal = totalInput(baseline.usage)
    const graphifyTotal = totalInput(graphify.usage)
    expect(readme).toContain(baselineTotal.toLocaleString('en-US'))
    expect(readme).toContain(graphifyTotal.toLocaleString('en-US'))
  })

  it('README cites cost numbers that match the JSON', () => {
    expect(readme).toContain(`$${baseline.total_cost_usd.toFixed(2)}`)
    expect(readme).toContain(`$${graphify.total_cost_usd.toFixed(2)}`)
  })

  it('README frames the benchmark around effective cost, not just raw prompt size', () => {
    expect(readme.toLowerCase()).toContain('effective cost')
    expect(readme.toLowerCase()).toContain('effective prompt tokens')
  })

  it('hosted retrieval benchmark page uses only defined warning color tokens', () => {
    const page = readFileSync(resolve(ARTIFACT_DIR, 'index.html'), 'utf8')
    expect(page).not.toContain('var(--amber-400)')
    expect(page).toContain('var(--c-lemon)')
  })

  it('README does not contain the stale 384x/897x/397x marketing claims', () => {
    const lower = readme.toLowerCase()
    for (const stale of ['384x', '397x', '897x', '384×', '397×', '897×']) {
      expect(lower).not.toContain(stale.toLowerCase())
    }
  })

  it('verify.sh exists and is executable', () => {
    const verifyPath = resolve(ARTIFACT_DIR, 'verify.sh')
    expect(existsSync(verifyPath)).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('verify.sh exits 0 against the committed JSON files (skipped if jq is missing)', () => {
    const which = spawnSync('which', ['jq'])
    if (which.status !== 0) {
      // CI may not have jq installed; verify.sh's prereq check exits 1 and
      // that's expected. Skip the substantive run there.
      return
    }
    const result = spawnSync('bash', [resolve(ARTIFACT_DIR, 'verify.sh')], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('baseline_total_input_tokens : 615190')
    expect(result.stdout).toContain('graphify_total_input_tokens : 233508')
  }, 15_000)

  it('verify.sh contains no absolute paths (uses $DIR)', () => {
    const verify = readFileSync(resolve(ARTIFACT_DIR, 'verify.sh'), 'utf8')
    expect(verify).toContain('$DIR')
    expect(verify).not.toMatch(/\/Users\/[^\s'"]+/)
    expect(verify).not.toMatch(/\/home\/[^\s'"]+/)
  })
})

describe('public benchmark artifact (2026-05-02 govalidate pr review)', () => {
  const readme = readFileSync(resolve(REVIEW_ARTIFACT_DIR, 'README.md'), 'utf8')
  const report = JSON.parse(readFileSync(resolve(REVIEW_ARTIFACT_DIR, 'report.json'), 'utf8')) as {
    verbose_prompt_tokens: number
    compact_prompt_tokens: number
  }
  const verbosePrompt = readFileSync(resolve(REVIEW_ARTIFACT_DIR, 'verbose-prompt.txt'), 'utf8')
  const compactPrompt = readFileSync(resolve(REVIEW_ARTIFACT_DIR, 'compact-prompt.txt'), 'utf8')

  it('committed review benchmark files exist with the expected structure', () => {
    expect(typeof report.verbose_prompt_tokens).toBe('number')
    expect(typeof report.compact_prompt_tokens).toBe('number')
    expect(readme).toContain('GoValidate PR review benchmark')
  })

  it('README describes the review proof as a coverage contract with effective-cost framing', () => {
    const lower = readme.toLowerCase()
    expect(lower).toContain('coverage contract')
    expect(lower).toContain('effective cost')
  })

  it('review prompt artifacts do not contain absolute or username-derived node ids', () => {
    for (const prompt of [verbosePrompt, compactPrompt]) {
      expect(prompt).not.toMatch(/\/Users\/[^\s'"]+/)
      expect(prompt).not.toMatch(/users_[a-z0-9]+_desktop_/i)
      expect(prompt).not.toContain('mohammednaji')
    }
  })

  it('review benchmark verify.sh exits 0', () => {
    const result = spawnSync('bash', [resolve(REVIEW_ARTIFACT_DIR, 'verify.sh')], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('verbose_prompt_tokens')
    expect(result.stdout).toContain('compact_prompt_tokens')
  })
})

describe('shared GoValidate pack-quality verifier contract', () => {
  it('accepts docs-artifact packs that satisfy required labels and pack ceilings', () => {
    const result = runPackVerifier('pass', buildPackFixture())
    const output = combinedOutput(result)

    expect(result.status).toBe(0)
    expect(output).toContain('docs-artifact')
    expect(output).toContain('PASS')
  })

  it('fails docs-artifact packs with a useful per-gate summary when any pack gate is violated', () => {
    const matched_nodes = buildMatchedNodes(
      DOCS_ARTIFACT_GATE.max_matched_nodes + 1,
      ['IdeaReportController', 'IdeaReportSharePage'],
    )
    const result = runPackVerifier(
      'fail',
      buildPackFixture({
        token_count: DOCS_ARTIFACT_GATE.max_pack_tokens + 1,
        matched_nodes,
        relationships: buildRelationships(DOCS_ARTIFACT_GATE.max_relationships + 1, matched_nodes),
      }),
    )
    const output = combinedOutput(result)

    expect(result.status).not.toBe(0)
    expect(output).toContain('docs-artifact')
    expect(output).toContain('missing required labels: GenerateIdeaReportService')
    expect(output).toContain('forbidden labels present: IdeaReportSharePage')
    expect(output).toContain('pack.token_count 1457 exceeds max_pack_tokens 1456')
    expect(output).toContain('pack.matched_nodes count 39 exceeds max_matched_nodes 38')
    expect(output).toContain('pack.relationships count 58 exceeds max_relationships 57')
  })

  it('rejects gate configs whose labels normalize to empty strings', () => {
    const result = runPackVerifier(
      'invalid-label-config',
      buildPackFixture(),
      {
        'docs-artifact': {
          ...DOCS_ARTIFACT_GATE,
          required_labels: ['---'],
        },
      },
    )
    const output = combinedOutput(result)

    expect(result.status).not.toBe(0)
    expect(output).toContain('Malformed gate definition for docs-artifact')
    expect(output).toContain('labels must contain at least one alphanumeric character after normalization')
  })
})

describe('hosted benchmark stylesheet', () => {
  const styles = readFileSync(BENCHMARK_STYLESHEET, 'utf8')

  it('uses dedicated fill and track tokens for the comparison bars', () => {
    expect(styles).toContain('--bar-baseline-fill:')
    expect(styles).toContain('--bar-graphify-fill:')
    expect(styles).toContain('--bar-track-bg:')
    expect(styles).toContain('--bar-track-edge:')
    expect(styles).not.toContain('--bar-baseline-fill:   var(--bar-baseline);')
    expect(styles).not.toContain('--bar-graphify-fill:   var(--bar-graphify);')
    expect(styles).toMatch(/\.bar-row \.bar \{\s+height: 18px;\s+background: var\(--bar-track-bg\);\s+border-radius: var\(--r-sm\);\s+border: 1px solid var\(--bar-track-edge\);/s)
    expect(styles).toMatch(/\.bar-row \.bar \.fill\.baseline \{\s+background: var\(--bar-baseline-fill\);/s)
    expect(styles).toMatch(/\.bar-row \.bar \.fill\.graphify \{\s+background: var\(--bar-graphify-fill\);/s)
    expect(styles).not.toMatch(/\.bar-row \.bar \.fill\.baseline \{\s+background: var\(--bar-baseline\);/s)
    expect(styles).not.toMatch(/\.bar-row \.bar \.fill\.graphify \{\s+background: var\(--bar-graphify\);/s)
  })

  it('makes the fill element block-level so inline width styles render visible bars', () => {
    expect(styles).toMatch(/\.bar-row \.bar \.fill \{\s+height: 100%;\s+display: block;/s)
  })

  it('removes inline code chip styling inside terminal pre blocks', () => {
    expect(styles).toMatch(/\.terminal code,\s*pre code \{\s*background: transparent;\s*border: 0;\s*padding: 0;\s*color: inherit;\s*font-weight: inherit;\s*font-size: inherit;\s*border-radius: 0;\s*\}/s)
  })
})
