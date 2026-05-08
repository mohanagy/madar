import { describe, expect, it } from 'vitest'

import type { ContextInventoryEntry } from '../../src/contracts/context-inventory.js'
import { createContextInventoryEntry, normalizeContextInventorySource } from '../../src/runtime/context-inventory.js'

describe('context-inventory', () => {
  it('normalizes documentation sources and derives stable defaults', () => {
    expect(normalizeContextInventorySource({
      kind: 'documentation',
      locator: ' README.md ',
      metadata: {
        section: ' Usage ',
        title: ' Overview ',
      },
    })).toEqual({
      kind: 'docs',
      locator: 'README.md',
      label: 'README.md',
      metadata: {
        path: 'README.md',
        section: 'Usage',
        title: 'Overview',
      },
    })
  })

  it('rejects invalid source descriptors', () => {
    expect(() => normalizeContextInventorySource({
      kind: 'wiki',
      locator: 'README.md',
    })).toThrow('Unsupported context inventory source kind: wiki')

    expect(() => normalizeContextInventorySource({
      kind: 'diff',
      locator: 'HEAD~1..HEAD',
      metadata: {
        base_ref: 'HEAD~1',
      },
    })).toThrow('Diff inventory source metadata requires both base_ref and head_ref')

    expect(() => normalizeContextInventorySource({
      kind: 'log',
      locator: 'vitest',
      metadata: {
        line_start: 10,
        line_end: 3,
      },
    })).toThrow('Context inventory line_end must be greater than or equal to line_start')
  })

  it('creates serializable inventory entries with normalized source metadata', () => {
    const entry = createContextInventoryEntry({
      id: ' build-errors ',
      source: {
        kind: 'log',
        locator: ' vitest ',
        label: ' test log ',
        metadata: {
          command: ' npm run test:run ',
          stream: 'stderr',
        },
      },
      content: 'FAIL tests/unit/context-inventory.test.ts',
      summary: ' surfaced failures ',
      token_count: 42,
      tags: [' runtime ', 'tests', 'runtime'],
      attributes: {
        exit_code: 1,
        failed: true,
        refs: ['tests/unit/context-inventory.test.ts'],
      },
    })

    const parsed = JSON.parse(JSON.stringify(entry)) as ContextInventoryEntry
    expect(parsed).toEqual({
      version: 1,
      id: 'build-errors',
      source: {
        kind: 'logs',
        locator: 'vitest',
        label: 'test log',
        metadata: {
          command: 'npm run test:run',
          stream: 'stderr',
        },
      },
      content: 'FAIL tests/unit/context-inventory.test.ts',
      summary: 'surfaced failures',
      token_count: 42,
      tags: ['runtime', 'tests'],
      attributes: {
        exit_code: 1,
        failed: true,
        refs: ['tests/unit/context-inventory.test.ts'],
      },
    })
  })
})
