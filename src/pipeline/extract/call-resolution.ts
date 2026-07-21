import type { ExtractionEdge, ExtractionNode } from './contracts.js'
import { createEdge, normalizeLabel } from './core.js'

export interface PendingCall {
  callerId: string
  calleeName: string
  line: number
  preferredClassId?: string
  preferredTargetId?: string
  strictPreferredClass?: boolean
}

export interface PendingCallInput {
  callerId: string
  calleeName: string
  line: number
  preferredClassId?: string | undefined
  preferredTargetId?: string | undefined
  strictPreferredClass?: boolean | undefined
}

export function addPendingCall(pendingCalls: PendingCall[], call: PendingCallInput): void {
  if (call.preferredClassId || call.preferredTargetId) {
    pendingCalls.push({
      callerId: call.callerId,
      calleeName: call.calleeName,
      line: call.line,
      ...(call.preferredClassId ? { preferredClassId: call.preferredClassId } : {}),
      ...(call.preferredTargetId ? { preferredTargetId: call.preferredTargetId } : {}),
      ...(call.strictPreferredClass ? { strictPreferredClass: true } : {}),
    })
    return
  }

  pendingCalls.push({
    callerId: call.callerId,
    calleeName: call.calleeName,
    line: call.line,
  })
}

export function addResolvedCalls(
  edges: ExtractionEdge[],
  pendingCalls: PendingCall[],
  nodes: ExtractionNode[],
  sourceFile: string,
  methodIdsByClass: Map<string, string>,
): void {
  const labelToId = new Map<string, string>()
  for (const node of nodes) {
    labelToId.set(normalizeLabel(node.label), node.id)
  }

  const seenPairs = new Set<string>()
  for (const pendingCall of pendingCalls) {
    const preferredTargetId = pendingCall.preferredTargetId
    const preferredKey = pendingCall.preferredClassId ? `${pendingCall.preferredClassId}:${pendingCall.calleeName.toLowerCase()}` : null
    const preferredClassTargetId = preferredKey ? methodIdsByClass.get(preferredKey) : undefined
    if (pendingCall.strictPreferredClass && preferredKey && !preferredClassTargetId && !preferredTargetId) {
      continue
    }

    const targetId = preferredTargetId ?? preferredClassTargetId ?? labelToId.get(pendingCall.calleeName.toLowerCase())
    if (!targetId || targetId === pendingCall.callerId) {
      continue
    }

    const pairKey = `${pendingCall.callerId}->${targetId}`
    if (seenPairs.has(pairKey)) {
      continue
    }
    seenPairs.add(pairKey)
    edges.push(createEdge(pendingCall.callerId, targetId, 'calls', sourceFile, pendingCall.line, 'EXTRACTED', 1.0))
  }
}

export function normalizeImportTarget(specifier: string): string {
  const cleaned = specifier.replace(/["'<>;]/g, '')
  const parts = cleaned.split(/[/\\.:]+/).filter(Boolean)
  return parts.at(-1) ?? cleaned
}

export function braceDelta(line: string): number {
  return [...line].reduce((total, character) => total + (character === '{' ? 1 : character === '}' ? -1 : 0), 0)
}
