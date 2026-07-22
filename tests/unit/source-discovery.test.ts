import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  classifySourceDomain,
  isDiscoveryPathIgnored,
  isManagedAgentInstructionFile,
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

  it('still hard-ignores top-level lib build output', () => {
    const file = join(sandbox, 'lib/index.js')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, 'export function helper() { return 1 }\n', 'utf8')

    const patterns = loadMadarignorePatterns(sandbox)

    expect(isDiscoveryPathIgnored(file, sandbox, patterns)).toBe(true)
    expect(classifySourceDomain(file, sandbox)).toBe('build_artifact')
  })

  it('still hard-ignores top-level lib declaration output', () => {
    const file = join(sandbox, 'lib/helper.d.ts')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, 'export declare function helper(): number\n', 'utf8')

    const patterns = loadMadarignorePatterns(sandbox)

    expect(isDiscoveryPathIgnored(file, sandbox, patterns)).toBe(true)
    expect(classifySourceDomain(file, sandbox)).toBe('build_artifact')
  })

  it('does not hard-ignore hand-written TypeScript source under top-level lib', () => {
    const file = join(sandbox, 'lib/middleware/link.ts')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, 'export function linkMiddleware() { return 1 }\n', 'utf8')

    const patterns = loadMadarignorePatterns(sandbox)

    expect(isDiscoveryPathIgnored(file, sandbox, patterns)).toBe(false)
    expect(classifySourceDomain(file, sandbox)).toBe('production')
  })

  it('recognizes relative managed instruction files under Windows roots', () => {
    const root = 'D:\\a\\madar\\madar'

    expect(isManagedAgentInstructionFile('AGENTS.md', root)).toBe(true)
    expect(isManagedAgentInstructionFile(`${root}\\CLAUDE.md`, root)).toBe(true)
  })
})
