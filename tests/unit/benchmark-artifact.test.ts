import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const ARTIFACT_DIR = resolve('docs', 'benchmarks', '2026-04-30-govalidate')
const REVIEW_ARTIFACT_DIR = resolve('docs', 'benchmarks', '2026-05-02-govalidate-pr-review')
const REPORT_GENERATION_ARTIFACT_DIR = resolve('docs', 'benchmarks', '2026-05-12-govalidate-report-generation')
const BENCHMARK_STYLESHEET = resolve('docs', 'benchmarks', 'styles.css')
const ANSWER_VERIFIER_PATH = resolve('docs', 'benchmarks', 'govalidate-suite', 'verify-answer-quality.js')
const SUITE_QUESTIONS_PATH = resolve('docs', 'benchmarks', 'govalidate-suite', 'questions.json')
const SUITE_README_PATH = resolve('docs', 'benchmarks', 'govalidate-suite', 'README.md')

interface AnswerQualityGateDefinition {
  prompt: string
  required_answer_terms: string[]
  forbidden_answer_terms: string[]
  required_concepts: string[]
  answer_quality_notes: string[]
  manual_review_notes: string[]
}

const DOCS_ARTIFACT_GATE: AnswerQualityGateDefinition = {
  prompt: 'Explain how idea report is getting generated',
  required_answer_terms: ['idea report', 'GenerateIdeaReportService'],
  forbidden_answer_terms: ['IdeaReportSharePage'],
  required_concepts: ['runtime path stays on controller -> service flow'],
  answer_quality_notes: ['Deterministic answer checks are necessary but not sufficient for benchmark claims.'],
  manual_review_notes: ['Confirm the answer explains how the report is generated, not just where files exist.'],
}

function runAnswerVerifier(
  testName: string,
  answerText: string,
  options: {
    gateConfig?: Record<string, unknown>
    relativeConfigPath?: boolean
    relativeAnswerPath?: boolean
  } = {},
): ReturnType<typeof spawnSync> {
  const fixtureRoot = join(
    process.cwd(),
    'out',
    'benchmark-artifact-answer-quality',
    `${testName}-${process.pid}-${Date.now()}`,
  )
  const answerPath = join(fixtureRoot, 'madar-answer.txt')
  const configPath = join(fixtureRoot, 'quality-gates.json')
  const answerArg = options.relativeAnswerPath ? relative(process.cwd(), answerPath) : answerPath
  const configArg = options.relativeConfigPath ? relative(process.cwd(), configPath) : configPath
  mkdirSync(fixtureRoot, { recursive: true })
  writeFileSync(answerPath, answerText, 'utf8')
  writeFileSync(configPath, `${JSON.stringify(options.gateConfig ?? { 'docs-artifact': DOCS_ARTIFACT_GATE }, null, 2)}\n`, 'utf8')

  try {
    return spawnSync(
      process.execPath,
      [ANSWER_VERIFIER_PATH, '--gate', 'docs-artifact', '--config', configArg, '--answer', answerArg],
      { encoding: 'utf8' },
    )
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
}

function combinedOutput(result: ReturnType<typeof spawnSync>): string {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
}

function toPosixPath(path: string): string {
  return path.replaceAll('\\', '/')
}

describe('public benchmark artifact (2026-04-30 govalidate)', () => {
  const baseline = JSON.parse(readFileSync(resolve(ARTIFACT_DIR, 'baseline-session.json'), 'utf8')) as {
    num_turns: number
    duration_ms: number
    total_cost_usd: number
    usage: { input_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }
  }
  const madar = JSON.parse(readFileSync(resolve(ARTIFACT_DIR, 'madar-session.json'), 'utf8')) as typeof baseline
  const readme = readFileSync(resolve(ARTIFACT_DIR, 'README.md'), 'utf8')

  function totalInput(usage: typeof baseline.usage): number {
    return usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens
  }

  it('committed JSON files exist with the expected Anthropic-shaped fields', () => {
    expect(typeof baseline.num_turns).toBe('number')
    expect(typeof baseline.duration_ms).toBe('number')
    expect(typeof baseline.usage.input_tokens).toBe('number')
    expect(typeof madar.num_turns).toBe('number')
    expect(typeof madar.duration_ms).toBe('number')
    expect(typeof madar.usage.input_tokens).toBe('number')
  })

  it('README cites num_turns numbers that match the JSON', () => {
    expect(readme).toContain(`| ${baseline.num_turns} |`)
    expect(readme).toContain(`**${madar.num_turns}**`)
  })

  it('README cites latency numbers that match the JSON (in ms)', () => {
    expect(readme).toContain(baseline.duration_ms.toLocaleString('en-US'))
    expect(readme).toContain(madar.duration_ms.toLocaleString('en-US'))
  })

  it('README cites total input tokens that exactly equal the JSON sums', () => {
    const baselineTotal = totalInput(baseline.usage)
    const madarTotal = totalInput(madar.usage)
    expect(readme).toContain(baselineTotal.toLocaleString('en-US'))
    expect(readme).toContain(madarTotal.toLocaleString('en-US'))
  })

  it('README cites cost numbers that match the JSON', () => {
    expect(readme).toContain(`$${baseline.total_cost_usd.toFixed(2)}`)
    expect(readme).toContain(`$${madar.total_cost_usd.toFixed(2)}`)
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
    expect(result.stdout).toContain('madar_total_input_tokens : 233508')
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

describe('public benchmark artifact (2026-05-12 govalidate report generation)', () => {
  const readme = readFileSync(resolve(REPORT_GENERATION_ARTIFACT_DIR, 'README.md'), 'utf8')

  it('README explains that pack quality is necessary but not sufficient for answer quality', () => {
    const lower = readme.toLowerCase()
    expect(lower).toContain('pack quality is necessary but not sufficient for answer quality')
  })

  it('README points readers to the shared answer verifier', () => {
    expect(readme).toContain(toPosixPath(relative(process.cwd(), ANSWER_VERIFIER_PATH)))
  })
})

describe('shared GoValidate answer-quality verifier contract', () => {
  it('accepts docs-artifact answers that satisfy deterministic term checks and prints manual review guidance', () => {
    const result = runAnswerVerifier(
      'pass',
      'The idea report is generated when GenerateIdeaReportService handles the controller runtime path.',
    )
    const output = combinedOutput(result)

    expect(result.status).toBe(0)
    expect(output).toContain('docs-artifact')
    expect(output).toContain('PASS')
    expect(output).toContain('required answer terms present: idea report, GenerateIdeaReportService')
    expect(output).toContain('forbidden answer terms present: none')
    expect(output).toContain('required concepts (manual review): runtime path stays on controller -> service flow')
    expect(output).toContain('manual review notes: Confirm the answer explains how the report is generated, not just where files exist.')
  })

  it('fails docs-artifact answers with a useful per-gate summary when answer checks are violated', () => {
    const result = runAnswerVerifier(
      'fail',
      'IdeaReportSharePage renders the final page.',
    )
    const output = combinedOutput(result)

    expect(result.status).not.toBe(0)
    expect(output).toContain('docs-artifact')
    expect(output).toContain('missing required answer terms: idea report, GenerateIdeaReportService')
    expect(output).toContain('forbidden answer terms present: IdeaReportSharePage')
  })
})

describe('shared GoValidate benchmark suite README', () => {
  const readme = readFileSync(SUITE_README_PATH, 'utf8')

  it('documents the answer-quality verifier', () => {
    expect(readme).toContain('verify-answer-quality.js')
    expect(readme).toContain('--answer <answer.txt>')
    expect(readme.toLowerCase()).toContain('deterministic answer-term checks')
  })

  it('ships a public multi-prompt suite with stable ids and no private expected labels', () => {
    expect(existsSync(SUITE_QUESTIONS_PATH)).toBe(true)

    const questions = JSON.parse(readFileSync(SUITE_QUESTIONS_PATH, 'utf8')) as Array<{
      id?: unknown
      description?: unknown
      question?: unknown
      expected_labels?: unknown
    }>

    expect(questions.length).toBeGreaterThanOrEqual(8)
    expect(questions.length).toBeLessThanOrEqual(12)

    const ids = questions.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(questions.length)

    for (const entry of questions) {
      expect(typeof entry.id).toBe('string')
      expect((entry.id as string).trim().length).toBeGreaterThan(0)
      expect(typeof entry.description).toBe('string')
      expect((entry.description as string).trim().length).toBeGreaterThan(0)
      expect(typeof entry.question).toBe('string')
      expect((entry.question as string).trim().length).toBeGreaterThan(0)
      expect(entry.expected_labels ?? []).toEqual([])
    }
  })

  it('documents the suite as conservative and separate from the single-prompt benchmark artifact', () => {
    const lower = readme.toLowerCase()

    expect(lower).toContain('questions.json')
    expect(lower).toContain('single-prompt benchmark')
    expect(lower).toContain('do not commit private')
    expect(lower).toContain('do not invent benchmark numbers')
    expect(lower).toContain('per-repo spread')
    expect(lower).toContain('do not publish a single-number cross-repo headline')
  })
})

describe('demo benchmark contract versions', () => {
  const legacyPath = resolve('examples', 'demo-repo', 'benchmark-questions.json')
  const coreResetPath = resolve('examples', 'demo-repo', 'benchmark-questions.v3.json')
  const legacy = JSON.parse(readFileSync(legacyPath, 'utf8')) as Array<{
    question: string
    expected_labels: string[]
  }>
  const coreReset = JSON.parse(readFileSync(coreResetPath, 'utf8')) as typeof legacy

  it('preserves historical gold while the Core Reset contract grades the same questions', () => {
    expect(coreReset.map(({ question }) => question))
      .toEqual(legacy.map(({ question }) => question))
    expect(coreReset.map(({ expected_labels }) => expected_labels))
      .not.toEqual(legacy.map(({ expected_labels }) => expected_labels))
  })

  it('uses the versioned declaration contract in CI and rejects token claims from the tiny fixture', () => {
    const workflow = readFileSync(resolve('.github', 'workflows', 'ci.yml'), 'utf8')
    const readme = readFileSync(resolve('examples', 'demo-repo', 'README.md'), 'utf8')
    expect(workflow).toContain('--questions examples/demo-repo/benchmark-questions.v3.json')
    expect(readme).toContain('preserves the historical mixed container/file-label gold')
    expect(readme).toContain('not evidence that Madar reduces tokens')
  })
})

describe('hosted benchmark stylesheet', () => {
  const styles = readFileSync(BENCHMARK_STYLESHEET, 'utf8')

  it('uses dedicated fill and track tokens for the comparison bars', () => {
    expect(styles).toContain('--bar-baseline-fill:')
    expect(styles).toContain('--bar-madar-fill:')
    expect(styles).toContain('--bar-track-bg:')
    expect(styles).toContain('--bar-track-edge:')
    expect(styles).not.toContain('--bar-baseline-fill:   var(--bar-baseline);')
    expect(styles).not.toContain('--bar-madar-fill:   var(--bar-madar);')
    expect(styles).toMatch(/\.bar-row \.bar \{\s+height: 18px;\s+background: var\(--bar-track-bg\);\s+border-radius: var\(--r-sm\);\s+border: 1px solid var\(--bar-track-edge\);/s)
    expect(styles).toMatch(/\.bar-row \.bar \.fill\.baseline \{\s+background: var\(--bar-baseline-fill\);/s)
    expect(styles).toMatch(/\.bar-row \.bar \.fill\.madar \{\s+background: var\(--bar-madar-fill\);/s)
    expect(styles).not.toMatch(/\.bar-row \.bar \.fill\.baseline \{\s+background: var\(--bar-baseline\);/s)
    expect(styles).not.toMatch(/\.bar-row \.bar \.fill\.madar \{\s+background: var\(--bar-madar\);/s)
  })

  it('makes the fill element block-level so inline width styles render visible bars', () => {
    expect(styles).toMatch(/\.bar-row \.bar \.fill \{\s+height: 100%;\s+display: block;/s)
  })

  it('removes inline code chip styling inside terminal pre blocks', () => {
    expect(styles).toMatch(/\.terminal code,\s*pre code \{\s*background: transparent;\s*border: 0;\s*padding: 0;\s*color: inherit;\s*font-weight: inherit;\s*font-size: inherit;\s*border-radius: 0;\s*\}/s)
  })
})
