import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

interface PackageManifest {
  bin?: Record<string, string>
  description?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  keywords?: string[]
  license?: string
  name?: string
  overrides?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  scripts?: Record<string, string>
  version?: string
}

interface PackageLock {
  version?: string
  packages?: Record<string, { version?: string }>
}

function loadPackageManifest(): PackageManifest {
  return JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as PackageManifest
}

function loadPackageLock(): PackageLock {
  return JSON.parse(readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8')) as PackageLock
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

function loadChangelog(): string {
  return readFileSync(join(process.cwd(), 'CHANGELOG.md'), 'utf8')
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

function loadContextPacksDoc(): string {
  return readFileSync(join(process.cwd(), 'docs', 'concepts', 'context-packs.md'), 'utf8')
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

  it('keeps package.json and package-lock.json on the same release version', () => {
    const manifest = loadPackageManifest()
    const packageLock = loadPackageLock()

    expect(packageLock.version).toBe(manifest.version)
    expect(packageLock.packages?.['']?.version).toBe(manifest.version)
  })

  it('keeps the renamed package metadata aligned with the scoped Madar package surface', () => {
    const manifest = loadPackageManifest()

    expect(manifest.name).toBe('@lubab/madar')
    expect(manifest.bin).toEqual({
      madar: 'dist/src/cli/bin.js',
    })
    expect(Object.keys(manifest.scripts ?? {})).not.toEqual(expect.arrayContaining([
      'compat:prepare',
      'compat:pack:dry-run',
      'compat:publish:dry-run',
      'compat:publish:public',
    ]))
  })

  it('does not ship consumer install lifecycle scripts', () => {
    const scripts = loadPackageManifest().scripts ?? {}

    expect(scripts).not.toHaveProperty('preinstall')
    expect(scripts).not.toHaveProperty('install')
    expect(scripts).not.toHaveProperty('postinstall')
    expect(scripts).not.toHaveProperty('prepare')
  })

  it('documents the current package version in the changelog', () => {
    const manifest = loadPackageManifest()

    expect(loadChangelog()).toContain(`## [${manifest.version}]`)
  })

  it('positions package metadata around outcome-first task-aware local packs instead of generic graph marketing', () => {
    const manifest = loadPackageManifest()
    const readme = loadReadme().toLowerCase()
    const contextPacks = loadContextPacksDoc().toLowerCase()
    const keywords = manifest.keywords ?? []

    expect(manifest.description?.toLowerCase()).toContain('stop')
    expect(manifest.description?.toLowerCase()).toContain('typescript/node')
    expect(manifest.description?.toLowerCase()).toContain('task-aware')
    expect(manifest.description?.toLowerCase()).toContain('what runs for this task')
    expect(manifest.description?.toLowerCase()).toContain('local')
    expect(manifest.description?.toLowerCase()).not.toContain('context plane')
    expect(manifest.description?.toLowerCase()).not.toContain('context compiler')
    expect(keywords).toEqual(expect.arrayContaining(['nodejs', 'code-review', 'impact-analysis']))
    expect(keywords).not.toContain('context-plane')
    expect(keywords).not.toContain('context-compiler')
    expect(readme).toContain('claude code')
    expect(readme).toContain('cursor')
    expect(readme).toContain('codex')
    expect(readme).toContain('copilot')
    expect(readme).toContain('repo context it needs before it starts searching')
    expect(readme).toContain('local graph')
    expect(readme).toContain('task-aware context pack')
    expect(contextPacks).toContain('deterministic local context compilation')
    expect(readme).not.toContain('context plane')
    expect(readme).not.toContain('context compiler')
  })

  it('keeps the command surface aligned with pack/prompt automation and MCP docs', () => {
    const readme = loadReadme()
    const examples = readFileSync(join(process.cwd(), 'examples', 'mcp-tool-examples.md'), 'utf8')

    expect(readme).toContain('madar pack')
    expect(readme).toContain('madar prompt')
    expect(examples).toContain('context_pack')
    expect(examples).toContain('context_prompt')
  })

  it('documents broad runtime-generation pack compaction in the context-pack docs', () => {
    const contextPacks = readFileSync(join(process.cwd(), 'docs', 'concepts', 'context-packs.md'), 'utf8').toLowerCase()

    expect(contextPacks).toContain('runtime-generation prompts stay compact')
    expect(contextPacks).toContain('shared-hub fan-out')
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
    expect(ciWorkflow).toContain('recall < 90')
    expect(ciWorkflow).toContain('mrr < 0.95')
  })

  it('documents framework-aware JS/TS support and conservative deeper retrieval hints in the language capability matrix', () => {
    const matrix = loadLanguageCapabilityMatrix()

    expect(matrix).toContain('## Framework awareness')
    expect(matrix).toContain('Express')
    expect(matrix).toContain('Redux Toolkit')
    expect(matrix).toContain('React Router')
    expect(matrix).toContain('NestJS')
    expect(matrix).toContain('Next.js')
    expect(matrix).toContain('Hono')
    expect(matrix).toContain('Fastify')
    expect(matrix).toContain('tRPC')
    expect(matrix).toContain('Prisma')
    expect(matrix).toContain('`framework_role`')
    expect(matrix).toContain('compact MCP payloads by default')
    expect(matrix).toContain('request-flow')
    expect(matrix).toContain('storage')
    expect(matrix).toContain('runtime-boundary')
    expect(matrix).toContain('generic AST structure')
    expect(matrix).toContain('visible client/server boundaries')
    expect(matrix).toContain('source-visible Hono/Fastify route ownership')
    expect(matrix).toContain('In default auto mode, Hono, Fastify, tRPC, and Prisma contribute conservative request-flow and storage hints')
  })

  it('pins non-vulnerable dependency floors for the CI security audit', () => {
    const manifest = loadPackageManifest()
    const devDependencies = manifest.devDependencies ?? {}
    const dependencies = manifest.dependencies ?? {}
    const peerDependencies = manifest.peerDependencies ?? {}
    const peerDependenciesMeta = manifest.peerDependenciesMeta ?? {}

    expect(isAtLeastVersion(devDependencies.vite, [8, 0, 11])).toBe(true)
    expect(devDependencies.vite).toMatch(/^[~^]?8\./)
    expect(dependencies['@xenova/transformers']).toBeUndefined()
    expect(dependencies['@huggingface/transformers']).toBeUndefined()
    expect(typeof peerDependencies['@huggingface/transformers']).toBe('string')
    expect(peerDependenciesMeta['@huggingface/transformers']).toEqual({ optional: true })
  })

  it('caps vitest worker parallelism to keep the full suite stable on shared machines', () => {
    const vitestConfig = loadVitestConfig()

    expect(vitestConfig).toContain('maxWorkers: 4')
  })
})
