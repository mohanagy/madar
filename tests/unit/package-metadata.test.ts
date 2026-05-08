import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

interface PackageManifest {
  description?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  keywords?: string[]
  license?: string
  overrides?: Record<string, string>
}

function loadPackageManifest(): PackageManifest {
  return JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as PackageManifest
}

function loadDependabotConfig(): string {
  return readFileSync(join(process.cwd(), '.github', 'dependabot.yml'), 'utf8')
}

function loadCiWorkflow(): string {
  return readFileSync(join(process.cwd(), '.github', 'workflows', 'ci.yml'), 'utf8')
}

function loadReadme(): string {
  return readFileSync(join(process.cwd(), 'README.md'), 'utf8')
}

function loadContributingGuide(): string {
  return readFileSync(join(process.cwd(), 'CONTRIBUTING.md'), 'utf8')
}

function loadVitestConfig(): string {
  return readFileSync(join(process.cwd(), 'vitest.config.ts'), 'utf8')
}

function loadLanguageCapabilityMatrix(): string {
  return readFileSync(join(process.cwd(), 'docs', 'language-capability-matrix.md'), 'utf8')
}

function normalizeVersionRange(range: string | undefined): string {
  return (range ?? '').replace(/^[\^~]/, '')
}

function parseVersion(version: string | undefined): [number, number, number] {
  const [major = '0', minor = '0', patch = '0'] = normalizeVersionRange(version).split('.')
  return [
    Number.parseInt(major, 10) || 0,
    Number.parseInt(minor, 10) || 0,
    Number.parseInt(patch, 10) || 0,
  ]
}

function isAtLeastVersion(actual: string | undefined, minimum: readonly [number, number, number]): boolean {
  const [currentMajor, currentMinor, currentPatch] = parseVersion(actual)
  const [minimumMajor, minimumMinor, minimumPatch] = minimum

  if (currentMajor !== minimumMajor) {
    return currentMajor > minimumMajor
  }
  if (currentMinor !== minimumMinor) {
    return currentMinor > minimumMinor
  }
  if (currentPatch !== minimumPatch) {
    return currentPatch > minimumPatch
  }

  return true
}

describe('package metadata', () => {
  it('keeps vitest coverage tooling aligned with vitest', () => {
    const devDependencies = loadPackageManifest().devDependencies ?? {}

    expect(normalizeVersionRange(devDependencies['@vitest/coverage-v8'])).toBe(
      normalizeVersionRange(devDependencies.vitest),
    )
  })

  it('groups vitest tooling updates together in dependabot', () => {
    const dependabotConfig = loadDependabotConfig()

    expect(dependabotConfig).toContain('groups:')
    expect(dependabotConfig).toContain('test-tooling:')
    expect(dependabotConfig).toContain('patterns:')
    expect(dependabotConfig).toContain('- vitest')
    expect(dependabotConfig).toContain('- "@vitest/coverage-v8"')
  })

  it('keeps the declared project license aligned with MIT', () => {
    expect(loadPackageManifest().license).toBe('MIT')
    expect(loadReadme()).toContain('[![license MIT]')
    expect(loadReadme()).toContain('## License')
    expect(loadReadme()).toContain('MIT. Use it, fork it, ship it.')
    expect(loadContributingGuide()).toContain("licensed under this project's MIT license")
  })

  it('positions package metadata around the context plane and context compiler surface', () => {
    const manifest = loadPackageManifest()
    const readme = loadReadme().toLowerCase()

    expect(manifest.description?.toLowerCase()).toContain('context plane')
    expect(manifest.description?.toLowerCase()).toContain('context compiler')
    expect(manifest.keywords ?? []).toEqual(expect.arrayContaining(['context-plane', 'context-compiler']))
    expect(readme).toContain('context plane')
    expect(readme).toContain('context compiler')
  })

  it('keeps the README command surface aligned with pack and prompt automation flows', () => {
    const readme = loadReadme()

    expect(readme).toContain('graphify-ts pack')
    expect(readme).toContain('graphify-ts prompt')
    expect(readme).toContain('context_pack')
    expect(readme).toContain('context_prompt')
  })

  it('avoids circular maintainer guidance in the contributing guide', () => {
    const contributingGuide = loadContributingGuide()

    expect(contributingGuide).not.toContain('current GitHub repository settings')
  })

  it('keeps the eval regression workflow aligned with runner-backed eval requirements', () => {
    const ciWorkflow = loadCiWorkflow()

    expect(ciWorkflow).toContain('Enforce eval regression thresholds')
    expect(ciWorkflow).toContain('ci-prompt-runner.mjs')
    expect(ciWorkflow).toContain('--exec')
    expect(ciWorkflow).toContain('--yes')
    expect(ciWorkflow).toContain('Snippet coverage:')
    expect(ciWorkflow).toContain('snippet_coverage')
  })

  it('documents framework-aware JS/TS support explicitly in the language capability matrix', () => {
    const matrix = loadLanguageCapabilityMatrix()

    expect(matrix).toContain('## Framework awareness')
    expect(matrix).toContain('Express')
    expect(matrix).toContain('Redux Toolkit')
    expect(matrix).toContain('React Router')
    expect(matrix).toContain('NestJS')
    expect(matrix).toContain('Next.js')
    expect(matrix).toContain('`framework_role`')
    expect(matrix).toContain('compact MCP payloads by default')
  })

  it('pins non-vulnerable dependency floors for the CI security audit', () => {
    const manifest = loadPackageManifest()
    const devDependencies = manifest.devDependencies ?? {}
    const dependencies = manifest.dependencies ?? {}

    expect(isAtLeastVersion(devDependencies.vite, [6, 4, 2])).toBe(true)
    expect(devDependencies.vite).toMatch(/^[~^]?6\./)
    expect(dependencies['@xenova/transformers']).toBeUndefined()
    expect(typeof dependencies['@huggingface/transformers']).toBe('string')
  })

  it('caps vitest worker parallelism to keep the full suite stable on shared machines', () => {
    const vitestConfig = loadVitestConfig()

    expect(vitestConfig).toContain('maxWorkers: 4')
  })
})
