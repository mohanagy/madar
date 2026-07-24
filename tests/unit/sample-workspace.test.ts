import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadGraphArtifact } from '../../src/adapters/filesystem/graph-artifact.js'
import { generateIndex } from '../../src/application/generate-index.js'
import { retrieveContext } from '../../src/application/retrieve-context.js'
import { inspectQueryIndex } from '../../src/domain/query/index-status.js'
import { UserRepository } from '../../examples/sample-workspace/src/persistence/user-repository.js'
import { createPasswordResetService } from '../../examples/sample-workspace/src/services/password-reset-service.js'

interface PromptExample {
  question: string
  expected_labels: string[]
}

async function withTempDir<T>(
  callback: (tempDir: string) => T | Promise<T>,
): Promise<T> {
  const tempDir = mkdtempSync(join(tmpdir(), 'madar-sample-workspace-'))
  try {
    return await callback(tempDir)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function copySampleWorkspace(tempDir: string): string {
  const sourceRoot = resolve('examples/sample-workspace')
  const targetRoot = join(tempDir, 'sample-workspace')
  cpSync(sourceRoot, targetRoot, {
    recursive: true,
    filter: (source) => {
      const relativePath = relative(sourceRoot, source)
      return relativePath !== 'out' && !relativePath.startsWith(`out${sep}`)
    },
  })
  return targetRoot
}

describe('examples/sample-workspace', () => {
  it('generates an authenticated graph and answers a canonical query', async () => {
    expect(existsSync(resolve('examples/sample-workspace'))).toBe(true)

    await withTempDir((tempDir) => {
      const sampleRoot = copySampleWorkspace(tempDir)
      const prompts = JSON.parse(
        readFileSync(join(sampleRoot, 'prompt-examples.json'), 'utf8'),
      ) as PromptExample[]
      const prompt = prompts[0]
      expect(prompt).toBeDefined()

      const generated = generateIndex(sampleRoot)
      const graph = loadGraphArtifact(generated.graphPath)
      const result = retrieveContext(inspectQueryIndex(graph), {
        question: prompt?.question ?? '',
        budget: 1800,
      })

      expect(generated.nodeCount).toBeGreaterThan(0)
      expect(result.schema).toBe('madar.retrieve')
      expect(result.version).toBe(1)
      expect(result.outcome).toBe('evidence')
      expect(result.metrics.serialized_tokens).toBeLessThanOrEqual(1800)
      expect(
        (prompt?.expected_labels ?? []).some((label) =>
          result.matched_nodes.some((node) => node.label === label)),
      ).toBe(true)
    })
  })

  it('does not return the password reset token to the caller', () => {
    const userRepository = new UserRepository()
    const passwordResetService = createPasswordResetService({
      userRepository,
      sendPasswordResetEmail: () => ({ delivered: true, channel: 'email' }),
    })

    const result = passwordResetService.requestPasswordReset('sam@example.test')
    const user = userRepository.findUserByEmail('sam@example.test')

    expect(result).toEqual({ queued: true })
    expect(user?.resetToken).toBeTruthy()
    expect(user?.resetToken).not.toBe('reset-u-1')
  })

  it('returns the same queued response for unknown email addresses', () => {
    const userRepository = new UserRepository()
    const passwordResetService = createPasswordResetService({
      userRepository,
      sendPasswordResetEmail: () => ({ delivered: true, channel: 'email' }),
    })

    expect(
      passwordResetService.requestPasswordReset('sam@example.test'),
    ).toEqual({ queued: true })
    expect(
      passwordResetService.requestPasswordReset('missing@example.test'),
    ).toEqual({ queued: true })
    expect(
      userRepository.findUserByEmail('missing@example.test'),
    ).toBeUndefined()
  })
})
