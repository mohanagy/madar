import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, test } from 'vitest'

import { CHECKOUT_MARKER, HOOK_MARKER, install, status, uninstall } from '../../src/infrastructure/hooks.js'
import { shouldAssertExecutableBits } from './helpers/platform.js'

function withRepo(callback: (repoDir: string) => void): void {
  const repoDir = mkdtempSync(join(tmpdir(), 'sadeem-hooks-'))
  try {
    const gitDir = join(repoDir, '.git', 'hooks')
    mkdirSync(gitDir, { recursive: true })
    writeFileSync(join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8')
    callback(repoDir)
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
}

describe('hooks', () => {
  test('install creates both hooks and marks them executable', () => {
    withRepo((repoDir) => {
      const result = install(repoDir)
      const postCommit = join(repoDir, '.git', 'hooks', 'post-commit')
      const postCheckout = join(repoDir, '.git', 'hooks', 'post-checkout')
      expect(readFileSync(postCommit, 'utf8')).toContain(HOOK_MARKER)
      expect(readFileSync(postCheckout, 'utf8')).toContain(CHECKOUT_MARKER)
      if (shouldAssertExecutableBits()) {
        expect(statSync(postCommit).mode & 0o111).toBeGreaterThan(0)
      }
      expect(result).toContain('installed')
    })
  })

  test('install is idempotent and preserves existing hook content', () => {
    withRepo((repoDir) => {
      const postCommit = join(repoDir, '.git', 'hooks', 'post-commit')
      writeFileSync(postCommit, '#!/bin/bash\necho existing\n', 'utf8')
      chmodSync(postCommit, 0o755)
      install(repoDir)
      const second = install(repoDir)
      const content = readFileSync(postCommit, 'utf8')
      expect(content).toContain('existing')
      expect(content.match(new RegExp(HOOK_MARKER, 'g'))?.length ?? 0).toBe(1)
      expect(second).toContain('already installed')
    })
  })

  test('status reflects installed hooks', () => {
    withRepo((repoDir) => {
      install(repoDir)
      const result = status(repoDir)
      expect(result).toContain('post-commit')
      expect(result).toContain('post-checkout')
      expect(result).toContain('installed')
    })
  })

  test('uninstall removes sadeem hook content', () => {
    withRepo((repoDir) => {
      install(repoDir)
      const result = uninstall(repoDir)
      expect(result.toLowerCase()).toContain('removed')
      expect(() => readFileSync(join(repoDir, '.git', 'hooks', 'post-commit'), 'utf8')).toThrow()
    })
  })

  test('throws outside git repositories', () => {
    expect(() => install(join(tmpdir(), 'not-a-repo'))).toThrow(/git repository/i)
  })
})
