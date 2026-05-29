import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { formatHelp } from '../../src/cli/main.js'
import {
  parseCompareArgs,
  parseDoctorArgs,
  parsePackArgs,
  parsePromptArgs,
  parseQueryArgs,
  parseReviewCompareArgs,
  parseSaveResultArgs,
  parseServeArgs,
  parseSummaryArgs,
} from '../../src/cli/parser.js'
import { saveQueryResult } from '../../src/infrastructure/save-query-result.js'

function readText(path: string): string {
  return readFileSync(resolve(path), 'utf8')
}

const LEGACY_BRAND = ['g', 'r', 'a', 'p', 'h', 'i', 'f', 'y'].join('')
const LEGACY_OUT_DIR = `${LEGACY_BRAND}-out`

describe('rebrand surface', () => {
  it('keeps only the madar command and removes compatibility packaging scripts', () => {
    const manifest = JSON.parse(readText('package.json')) as {
      bin?: Record<string, string>
      scripts?: Record<string, string>
      postinstall?: string
    }

    expect(manifest.bin).toEqual({
      madar: 'dist/src/cli/bin.js',
    })
    expect(Object.keys(manifest.scripts ?? {})).not.toEqual(
      expect.arrayContaining([
        'compat:prepare',
        'compat:pack:dry-run',
        'compat:publish:dry-run',
        'compat:publish:public',
      ]),
    )
    expect(existsSync(resolve('src/infrastructure/compat-package.ts'))).toBe(false)
    expect(existsSync(resolve('scripts/prepare-legacy-compat-package.mjs'))).toBe(false)
    expect(JSON.stringify(manifest)).not.toContain(LEGACY_BRAND)
  })

  it('uses madar and out in help text and parser defaults', () => {
    const help = formatHelp()

    expect(help).toContain('Usage: madar <command>')
    expect(help).toContain('default out/graph.json')
    expect(help).toContain('default out/compare')
    expect(help).toContain('default out/review-compare')
    expect(help).toContain('default out/memory')
    expect(help).not.toContain('add <url>')
    expect(help).not.toContain(LEGACY_BRAND)
    expect(help).not.toContain(LEGACY_OUT_DIR)

    expect(parseQueryArgs(['how does auth work']).graphPath).toBe('out/graph.json')
    expect(parsePackArgs(['how does auth work']).graphPath).toBe('out/graph.json')
    expect(parsePromptArgs(['how does auth work', '--provider', 'claude']).graphPath).toBe('out/graph.json')
    expect(parseCompareArgs(['how does login work', '--exec', 'claude -p "$(cat {prompt_file})"']).outputDir).toBe(resolve('out/compare'))
    expect(parseReviewCompareArgs(['--exec', 'claude -p "$(cat {prompt_file})"']).outputDir).toBe(resolve('out/review-compare'))
    expect(parseSaveResultArgs(['--question', 'Q', '--answer', 'A']).memoryDir).toBe(resolve('out/memory'))
    expect(parseDoctorArgs([]).graphPath).toBe('out/graph.json')
    expect(parseSummaryArgs([]).graphPath).toBe('out/graph.json')
    expect(parseServeArgs([]).graphPath).toBe('out/graph.json')
  })

  it('writes madar as the saved result contributor', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'madar-save-result-'))

    try {
      const outputPath = saveQueryResult('How?', 'Like this.', join(tempDir, 'memory'))
      const content = readFileSync(outputPath, 'utf8')

      expect(content).toContain('contributor: "madar"')
      expect(content).not.toContain(LEGACY_BRAND)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('removes legacy branding from the main docs', () => {
    const readme = readText('README.md')
    const gettingStarted = readText('docs/tutorials/getting-started.md')
    const capabilityMatrix = readText('docs/language-capability-matrix.md')
    const releaseDoc = readText('docs/release.md')

    expect(readme).not.toContain(LEGACY_BRAND)
    expect(readme).not.toContain(LEGACY_OUT_DIR)
    expect(readme).not.toContain('## Credit')
    expect(readme).not.toContain('Safi Shamsi')
    expect(readme).not.toContain('original `madar`')
    expect(gettingStarted).not.toContain(LEGACY_BRAND)
    expect(gettingStarted).not.toContain(LEGACY_OUT_DIR)
    expect(capabilityMatrix).not.toContain('madar add <url>')
    expect(releaseDoc).not.toContain(LEGACY_BRAND)
    expect(releaseDoc).not.toContain(LEGACY_OUT_DIR)
  })
})
