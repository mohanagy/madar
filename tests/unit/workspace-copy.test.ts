import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it } from 'vitest'

import { copyWorkspaceForBenchmark } from '../../src/shared/workspace-copy.js'

describe('copyWorkspaceForBenchmark', () => {
  const tempRoots: string[] = []

  afterEach(() => {
    for (const tempRoot of tempRoots.splice(0)) {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('reuses shared top-level dependency trees without copying out or .git', () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'workspace-copy-source-'))
    const targetRoot = join(mkdtempSync(join(tmpdir(), 'workspace-copy-target-')), 'workspace')
    tempRoots.push(sourceRoot, dirname(targetRoot))

    mkdirSync(join(sourceRoot, 'src'), { recursive: true })
    mkdirSync(join(sourceRoot, 'out'), { recursive: true })
    mkdirSync(join(sourceRoot, '.git'), { recursive: true })
    mkdirSync(join(sourceRoot, 'node_modules', 'example'), { recursive: true })
    mkdirSync(join(targetRoot, 'node_modules'), { recursive: true })

    writeFileSync(join(sourceRoot, 'src', 'session.ts'), 'export const ok = true\n', 'utf8')
    writeFileSync(join(sourceRoot, 'out', 'graph.json'), '{"skip":true}\n', 'utf8')
    writeFileSync(join(sourceRoot, '.git', 'config'), '[core]\n', 'utf8')
    writeFileSync(join(sourceRoot, 'node_modules', 'example', 'index.js'), 'module.exports = true\n', 'utf8')

    copyWorkspaceForBenchmark(sourceRoot, targetRoot, { sharedTopLevelEntries: ['node_modules'] })

    expect(readFileSync(join(targetRoot, 'src', 'session.ts'), 'utf8')).toContain('ok = true')
    expect(existsSync(join(targetRoot, 'out'))).toBe(false)
    expect(existsSync(join(targetRoot, '.git'))).toBe(false)

    const linkedNodeModules = join(targetRoot, 'node_modules')
    expect(lstatSync(linkedNodeModules).isSymbolicLink()).toBe(true)
    expect(realpathSync(linkedNodeModules)).toBe(realpathSync(join(sourceRoot, 'node_modules')))
    expect(readFileSync(join(linkedNodeModules, 'example', 'index.js'), 'utf8')).toContain('module.exports = true')
  })
})
