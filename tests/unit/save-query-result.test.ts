import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { saveQueryResult } from '../../src/infrastructure/save-query-result.js'

function withTempDir(callback: (tempDir: string) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'madar-save-query-result-'))
  try {
    callback(tempDir)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.resetModules()
  vi.doUnmock('node:fs')
})

describe('saveQueryResult', () => {
  test('creates a markdown file with frontmatter and answer body', () => {
    withTempDir((tempDir) => {
      const output = saveQueryResult('what is attention?', 'Attention is softmax.', join(tempDir, 'memory'))
      const content = readFileSync(output, 'utf8')
      expect(content).toContain('question:')
      expect(content).toContain('Attention is softmax.')
      expect(output.endsWith('.md')).toBe(true)
    })
  })

  test('stores query type and capped source nodes', () => {
    withTempDir((tempDir) => {
      const output = saveQueryResult('q', 'a', join(tempDir, 'memory'), {
        queryType: 'path_query',
        sourceNodes: Array.from({ length: 20 }, (_, index) => `Node${index}`),
      })
      const content = readFileSync(output, 'utf8')
      expect(content).toContain('type: "path_query"')
      const line = content.split('\n').find((entry) => entry.startsWith('source_nodes:'))
      expect(line?.match(/"Node/g)?.length ?? 0).toBe(10)
    })
  })

  test('retries with a suffixed filename when exclusive creation loses a race', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-02T03:04:05Z'))

    const tempDir = mkdtempSync(join(tmpdir(), 'madar-save-query-result-'))
    try {
      const expectedBase = join(tempDir, 'memory', 'query_20260102_030405_q.md')

      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
        let injectedCollision = false
        return {
          ...actual,
          writeFileSync(path: Parameters<typeof actual.writeFileSync>[0], data: Parameters<typeof actual.writeFileSync>[1], options?: Parameters<typeof actual.writeFileSync>[2]): void {
            if (!injectedCollision && path === expectedBase) {
              injectedCollision = true
              const error = new Error(`EEXIST: file already exists, open '${expectedBase}'`) as NodeJS.ErrnoException
              error.code = 'EEXIST'
              throw error
            }
            Reflect.apply(actual.writeFileSync, actual, [path, data, options])
          },
        }
      })

      const { saveQueryResult: saveQueryResultWithMock } = await import('../../src/infrastructure/save-query-result.js')
      const output = saveQueryResultWithMock('q', 'a', join(tempDir, 'memory'))

      expect(output).toBe(join(tempDir, 'memory', 'query_20260102_030405_q_1.md'))
      expect(readFileSync(output, 'utf8')).toContain('## Answer')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
