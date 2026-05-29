import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { compactRetrieveResult, retrieveContext } from '../../src/runtime/retrieve.js'

function buildPromptCompetitionGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph()

  graph.addNode('service', {
    label: 'CheckoutFlowService',
    source_file: '/src/checkout/CheckoutFlowService.ts',
    line_number: 1,
    node_kind: 'function',
    file_type: 'code',
    community: 0,
  })

  graph.addNode('persist', {
    label: 'PersistOrderCenter',
    source_file: '/src/checkout/PersistOrderCenter.ts',
    line_number: 10,
    node_kind: 'function',
    file_type: 'code',
    community: 0,
  })

  graph.addNode('audit_helper', {
    label: 'ComposeEnvelopePayload',
    source_file: '/src/checkout/helpers/audit-envelope-helper.ts',
    line_number: 20,
    node_kind: 'function',
    file_type: 'code',
    community: 0,
  })

  graph.addNode('generic_helper', {
    label: 'CheckoutEnvelopeHelper',
    source_file: '/src/checkout/helpers/CheckoutEnvelopeHelper.ts',
    line_number: 30,
    node_kind: 'function',
    file_type: 'code',
    community: 0,
  })

  graph.addEdge('service', 'persist', { relation: 'calls' })
  graph.addEdge('service', 'audit_helper', { relation: 'calls' })
  graph.addEdge('service', 'generic_helper', { relation: 'calls' })

  return graph
}

function buildPromptDivergenceGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph()

  for (const [id, label, sourceFile, line] of [
    ['entry', 'CheckoutFlowController', '/src/checkout/CheckoutFlowController.ts', 0],
    ['service', 'CheckoutFlowService', '/src/checkout/CheckoutFlowService.ts', 1],
    ['persist', 'PersistOrderCenter', '/src/checkout/PersistOrderCenter.ts', 10],
    ['audit_helper', 'ComposeEnvelopePayload', '/src/checkout/helpers/audit-envelope-helper.ts', 20],
    ['receipt_helper', 'ComposeEnvelopePayload', '/src/checkout/helpers/receipt-envelope-helper.ts', 30],
    ['summary_helper', 'PrepareCheckoutSummary', '/src/checkout/helpers/PrepareCheckoutSummary.ts', 40],
    ['ledger_helper', 'WriteCheckoutLedger', '/src/checkout/helpers/WriteCheckoutLedger.ts', 50],
    ['metrics_helper', 'EmitCheckoutMetrics', '/src/checkout/helpers/EmitCheckoutMetrics.ts', 60],
  ] as const) {
    graph.addNode(id, {
      label,
      source_file: sourceFile,
      line_number: line,
      node_kind: 'function',
      file_type: 'code',
      community: 0,
    })
  }

  for (const [source, target] of [
    ['entry', 'service'],
    ['service', 'persist'],
    ['service', 'audit_helper'],
    ['service', 'receipt_helper'],
    ['service', 'summary_helper'],
    ['service', 'ledger_helper'],
    ['service', 'metrics_helper'],
    ['audit_helper', 'persist'],
    ['receipt_helper', 'persist'],
  ] as const) {
    graph.addEdge(source, target, { relation: 'calls' })
  }

  return graph
}

function compactedSourceFiles(question: string): string[] {
  const result = retrieveContext(buildPromptDivergenceGraph(), {
    question,
    budget: 80,
    fileType: 'code',
  })

  return compactRetrieveResult(result).matched_nodes.map((node) => node.source_file)
}

describe('retrieve prompt-symbol boost', () => {
  it('promotes a plain prompt identifier over a stronger generic checkout helper', () => {
    const result = retrieveContext(buildPromptCompetitionGraph(), {
      question: 'Explain the checkout flow around auditEnvelopeHelper',
      budget: 120,
      fileType: 'code',
    })

    const sourceFiles = result.matched_nodes.map((node) => node.source_file)
    expect(sourceFiles).toContain('/src/checkout/helpers/audit-envelope-helper.ts')
    expect(sourceFiles).toContain('/src/checkout/helpers/CheckoutEnvelopeHelper.ts')
    expect(sourceFiles.indexOf('/src/checkout/helpers/audit-envelope-helper.ts')).toBeLessThan(
      sourceFiles.indexOf('/src/checkout/helpers/CheckoutEnvelopeHelper.ts'),
    )
  })

  it('changes compact packs for different plain prompt identifiers without dropping the workflow spine', () => {
    const auditPack = compactedSourceFiles('Explain the checkout flow around auditEnvelopeHelper')
    const receiptPack = compactedSourceFiles('Explain the checkout flow around receiptEnvelopeHelper')

    expect(auditPack).not.toEqual(receiptPack)

    expect(auditPack).toContain('/src/checkout/helpers/audit-envelope-helper.ts')
    expect(receiptPack).toContain('/src/checkout/helpers/receipt-envelope-helper.ts')

    for (const pack of [auditPack, receiptPack]) {
      expect(pack).toContain('/src/checkout/CheckoutFlowService.ts')
      expect(pack).toContain('/src/checkout/PersistOrderCenter.ts')
    }
  })
})
