import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { runTryCommand } from '../../tools/eval/lib/infrastructure/try-command.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('runTryCommand', () => {
  it('builds once and returns the canonical evidence result', () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-try-'))
    roots.push(root)
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(
      join(root, 'src', 'repository.ts'),
      'export function saveOrder(id: string): string { return `saved:${id}` }\n',
      'utf8',
    )
    writeFileSync(
      join(root, 'src', 'service.ts'),
      [
        "import { saveOrder } from './repository.js'",
        'export function submitOrder(id: string): string {',
        '  return saveOrder(id)',
        '}',
        '',
      ].join('\n'),
      'utf8',
    )

    const output = runTryCommand({
      question: 'How does submit order call save order?',
      path: root,
    })
    const [, ...serialized] = output.split('\n')
    const result = JSON.parse(serialized.join('\n')) as {
      schema: string
      outcome: string
      matched_nodes: Array<{ label: string }>
    }

    expect(output).toContain('[madar try] Built ')
    expect(result.schema).toBe('madar.retrieve')
    expect(result.outcome).toBe('evidence')
    expect(result.matched_nodes.map((node) => node.label)).toEqual(
      expect.arrayContaining(['submitOrder()', 'saveOrder()']),
    )
  })

  it('propagates unsupported-corpus failure without a sample fallback', () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-try-empty-'))
    roots.push(root)

    expect(() => runTryCommand({
      question: 'How does authentication work?',
      path: root,
    })).toThrow('No supported TypeScript or JavaScript files')
  })
})
