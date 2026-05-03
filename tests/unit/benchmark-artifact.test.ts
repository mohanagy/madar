import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const ARTIFACT_DIR = resolve('docs', 'benchmarks', '2026-04-30-govalidate')
const REVIEW_ARTIFACT_DIR = resolve('docs', 'benchmarks', '2026-05-02-govalidate-pr-review')
const BENCHMARK_STYLESHEET = resolve('docs', 'benchmarks', 'styles.css')

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

  it('verify.sh exits 0 against the committed JSON files (skipped if jq is missing)', () => {
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
