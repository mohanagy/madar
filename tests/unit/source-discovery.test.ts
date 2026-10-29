import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  classifySourceDomain,
  isDiscoveryPathIgnored,
  loadMadarignorePatterns,
} from '../../src/shared/source-discovery.js'

function mkSandbox(): string {
  return mkdtempSync(join(tmpdir(), 'source-discovery-'))
}

describe('source discovery', () => {
  let sandbox: string

  beforeEach(() => {
    sandbox = mkSandbox()
  })

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  it('does not hard-ignore production code under src/lib', () => {
    const file = join(sandbox, 'src/lib/helper.ts')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, 'export function helper() { return 1 }\n', 'utf8')

    const patterns = loadMadarignorePatterns(sandbox)

    expect(isDiscoveryPathIgnored(file, sandbox, patterns)).toBe(false)
    expect(classifySourceDomain(file, sandbox)).toBe('production')
  })

  it('admits JavaScript runtime source under top-level lib', () => {
    for (const extension of ['js', 'cjs', 'mjs']) {
      const file = join(sandbox, `lib/index.${extension}`)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, 'export function helper() { return 1 }\n', 'utf8')
      expect(isDiscoveryPathIgnored(file, sandbox, loadMadarignorePatterns(sandbox))).toBe(false)
      expect(classifySourceDomain(file, sandbox)).toBe('production')
    }
  })

  it('admits lib declarations and preserves deliberate generated-output exclusion', () => {
    const file = join(sandbox, 'lib/helper.d.ts')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, 'export declare function helper(): number\n', 'utf8')

    expect(isDiscoveryPathIgnored(file, sandbox, loadMadarignorePatterns(sandbox))).toBe(false)
    expect(classifySourceDomain(file, sandbox)).toBe('production')
    writeFileSync(join(sandbox, '.madarignore'), 'lib/**\n')
    expect(isDiscoveryPathIgnored(file, sandbox, loadMadarignorePatterns(sandbox))).toBe(true)
  })

  it('does not hard-ignore hand-written TypeScript source under top-level lib', () => {
    const file = join(sandbox, 'lib/middleware/link.ts')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, 'export function linkMiddleware() { return 1 }\n', 'utf8')

    const patterns = loadMadarignorePatterns(sandbox)

    expect(isDiscoveryPathIgnored(file, sandbox, patterns)).toBe(false)
    expect(classifySourceDomain(file, sandbox)).toBe('production')
  })
})
