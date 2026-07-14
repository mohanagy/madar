import { describe, expect, test } from 'vitest'

import { watcherStateBlocksGraphReads, type WatcherStateV1 } from '../../src/contracts/watcher-state.js'
import { createWatcherState } from '../../src/infrastructure/watcher-state.js'

function readableState(): WatcherStateV1 {
  const state = createWatcherState('recursive-events', 30_000)
  state.status = 'idle'
  state.coverage = 'complete'
  state.policy_match = true
  return state
}

describe('watcher graph-read gate', () => {
  test.each(['starting', 'pending', 'reconciling', 'failed'] as const)('blocks %s status', (status) => {
    expect(watcherStateBlocksGraphReads({ ...readableState(), status })).toBe(true)
  })

  test.each(['unknown', 'failed'] as const)('blocks %s coverage', (coverage) => {
    expect(watcherStateBlocksGraphReads({ ...readableState(), coverage })).toBe(true)
  })

  test('blocks a generation-policy mismatch and permits a fully idle state', () => {
    expect(watcherStateBlocksGraphReads({ ...readableState(), policy_match: false })).toBe(true)
    expect(watcherStateBlocksGraphReads(readableState())).toBe(false)
  })
})

