import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { generateGraph } from '../../src/infrastructure/generate.js'
import { runContextPackCommand } from '../../src/infrastructure/context-pack-command.js'
import { UserRepository } from '../../examples/sample-workspace/src/persistence/user-repository.js'
import { createPasswordResetService } from '../../examples/sample-workspace/src/services/password-reset-service.js'

interface PromptExample {
  question: string
  expected_labels: string[]
}

function withTempDir<T>(callback: (tempDir: string) => T | Promise<T>): T | Promise<T> {
  const tempDir = mkdtempSync(join(tmpdir(), 'graphify-ts-sample-workspace-'))
  const finalize = () => rmSync(tempDir, { recursive: true, force: true })
  try {
    const result = callback(tempDir)
    if (result && typeof (result as Promise<T>).then === 'function') {
      return (result as Promise<T>).finally(finalize)
    }
    finalize()
    return result
  } catch (error) {
    finalize()
    throw error
  }
}

function copySampleWorkspace(tempDir: string): string {
  const sourceRoot = resolve('examples/sample-workspace')
  const targetRoot = join(tempDir, 'sample-workspace')
  cpSync(sourceRoot, targetRoot, {
    recursive: true,
    filter: (source) => {
      const relativePath = relative(sourceRoot, source)
      return relativePath !== 'graphify-out' && !relativePath.startsWith(`graphify-out${sep}`)
    },
  })
  return targetRoot
}

describe('examples/sample-workspace', () => {
  it('ships a small sample workspace that can generate a graph and answer a pack prompt', async () => {
    expect(existsSync(resolve('examples/sample-workspace'))).toBe(true)
    expect(existsSync(resolve('examples/sample-workspace/prompt-examples.json'))).toBe(true)

    await withTempDir(async (tempDir) => {
      const sampleRoot = copySampleWorkspace(tempDir)
      const promptExamples = JSON.parse(
        readFileSync(join(sampleRoot, 'prompt-examples.json'), 'utf8'),
      ) as PromptExample[]
      const firstPrompt = promptExamples[0]

      expect(firstPrompt).toBeDefined()
      const result = generateGraph(sampleRoot, { noHtml: true })
      const graphPath = join(sampleRoot, 'graphify-out', 'graph.json')
      const packOutput = await runContextPackCommand({
        prompt: firstPrompt?.question ?? '',
        budget: 1800,
        task: 'explain',
        graphPath,
      })
      const pack = JSON.parse(packOutput) as {
        pack: {
          matched_nodes: Array<{ label: string }>
        }
      }

      expect(result.nodeCount).toBeGreaterThan(0)
      expect(existsSync(graphPath)).toBe(true)
      expect(pack.pack.matched_nodes.length).toBeGreaterThan(0)
      expect(
        (firstPrompt?.expected_labels ?? []).some((label) =>
          pack.pack.matched_nodes.some((node) => node.label === label)),
      ).toBe(true)
    })
  })

  it('documents how to generate and pack against the sample workspace', () => {
    const tutorial = readFileSync(resolve('docs/tutorials/sample-workspace.md'), 'utf8')
    const readme = readFileSync(resolve('README.md'), 'utf8')

    if (tutorial.includes('npm run build')) {
      expect(tutorial.toLowerCase()).toContain('repository root')
    }
    expect(tutorial).toContain('graphify-ts generate examples/sample-workspace')
    expect(tutorial).toContain('graphify-ts pack')
    expect(tutorial).toContain('prompt-examples.json')
    expect(readme).toContain('examples/sample-workspace')
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
})
