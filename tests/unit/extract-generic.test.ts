import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { extractGenericCode } from '../../src/pipeline/extract/generic.js'

describe('extract generic language module', () => {
  it('extracts classes, methods, inheritance, imports, and resolved calls', () => {
    const root = mkdtempSync(join(tmpdir(), 'sadeem-extract-generic-'))
    try {
      const filePath = join(root, 'worker.java')
      writeFileSync(
        filePath,
        [
          'import java.util.List;',
          '',
          'class Parent {}',
          'class Worker extends Parent {',
          '  void run() {',
          '    helper();',
          '  }',
          '',
          '  void helper() {}',
          '}',
        ].join('\n'),
        'utf8',
      )

      const extraction = extractGenericCode(filePath)
      const nodeLabels = extraction.nodes.map((node) => node.label)
      const edgeSummary = extraction.edges.map((edge) => `${edge.source}:${edge.relation}:${edge.target}`)

      expect(nodeLabels).toEqual(expect.arrayContaining(['worker.java', 'Worker', 'Parent', '.run()', '.helper()']))
      expect(edgeSummary).toEqual(
        expect.arrayContaining([
          'worker:imports_from:list',
          'worker:contains:worker_parent',
          'worker:contains:worker_worker',
          'worker_worker:inherits:worker_parent',
          'worker_worker:method:worker_worker_run',
          'worker_worker_run:calls:worker_worker_helper',
        ]),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
