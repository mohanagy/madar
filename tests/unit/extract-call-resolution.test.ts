import type { ExtractionEdge, ExtractionNode } from '../../src/pipeline/extract/contracts.js'
import { addPendingCall, addResolvedCalls, braceDelta, type PendingCall } from '../../src/pipeline/extract/call-resolution.js'

describe('extract call resolution helpers', () => {
  it('resolves preferred class calls once and ignores self loops', () => {
    const pendingCalls: PendingCall[] = []
    addPendingCall(pendingCalls, { callerId: 'worker-run', calleeName: 'helper', line: 12, preferredClassId: 'worker' })
    addPendingCall(pendingCalls, { callerId: 'worker-run', calleeName: 'helper', line: 13, preferredClassId: 'worker' })
    addPendingCall(pendingCalls, { callerId: 'worker-run', calleeName: 'run', line: 14, preferredTargetId: 'worker-run' })

    const nodes: ExtractionNode[] = [
      { id: 'worker', label: 'Worker', source_file: 'worker.go', source_location: '1', file_type: 'code' },
      { id: 'worker-run', label: '.run()', source_file: 'worker.go', source_location: '12', file_type: 'code' },
      { id: 'worker-helper', label: '.helper()', source_file: 'worker.go', source_location: '20', file_type: 'code' },
    ]
    const edges: ExtractionEdge[] = []
    const methodIdsByClass = new Map([['worker:helper', 'worker-helper']])

    addResolvedCalls(edges, pendingCalls, nodes, 'worker.go', methodIdsByClass)

    expect(edges).toEqual([
      expect.objectContaining({
        source: 'worker-run',
        target: 'worker-helper',
        relation: 'calls',
        source_file: 'worker.go',
        source_location: 'L12',
      }),
    ])
    expect(braceDelta('func run() { if ready { call() } }')).toBe(0)
  })
})
