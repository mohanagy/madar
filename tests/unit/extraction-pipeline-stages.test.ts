import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createCapabilityRegistry } from '../../src/infrastructure/capabilities.js'
import { extract, extractWithPipelineResult } from '../../src/pipeline/extract.js'
import {
  dispatchSingleFileExtractionWithOutcome,
  selectExtractionCapability,
  type ExtractionFileOutcome,
} from '../../src/pipeline/extract/dispatch.js'
import {
  buildExtractionDiscoveryPlan,
  projectExtractionDiagnostics,
  resolveCrossFileExtraction,
  type ExtractionStageDiagnostic,
} from '../../src/pipeline/extract/pipeline.js'

describe('extraction pipeline stages', () => {
  it('normalizes discovered files and allowed targets independently', () => {
    const plan = buildExtractionDiscoveryPlan({
      files: ['/tmp/source.ts'],
      allowedTargets: ['/tmp/related.ts'],
      contextNodes: [{
        id: 'context',
        label: 'Context',
        source_file: '/tmp/context.ts',
        file_type: 'code',
      }],
    })

    expect(plan.files).toEqual(['/tmp/source.ts'])
    expect([...plan.allowedTargets]).toEqual(['/tmp/related.ts'])
    expect(plan.stemContextFiles).toEqual([
      '/tmp/source.ts',
      '/tmp/related.ts',
      '/tmp/context.ts',
    ])
  })

  it('does not duplicate discovery files when allowed targets default to the file set', () => {
    const plan = buildExtractionDiscoveryPlan({ files: ['/tmp/source.ts'] })

    expect(plan.stemContextFiles).toEqual(['/tmp/source.ts'])
    expect([...plan.allowedTargets]).toEqual(['/tmp/source.ts'])
  })

  it('selects a capability independently from handler execution', () => {
    const registry = createCapabilityRegistry([{
      id: 'custom:extract:typescript',
      kind: 'extract',
      fileType: 'code',
      extensions: ['.ts'],
    }])

    const selection = selectExtractionCapability('/tmp/example.ts', {
      registry,
      classifySourceFile: () => 'code',
    })

    expect(selection.sourceFileType).toBe('code')
    expect(selection.capability?.id).toBe('custom:extract:typescript')
  })

  it('returns the per-file outcome as first-class dispatch data', () => {
    const registry = createCapabilityRegistry([{
      id: 'custom:extract:typescript',
      kind: 'extract',
      fileType: 'code',
      extensions: ['.ts'],
    }])
    const result = dispatchSingleFileExtractionWithOutcome(
      '/tmp/example.ts',
      new Set(['/tmp/example.ts']),
      {
        'custom:extract:typescript': () => ({
          nodes: [{ id: 'example', label: 'example()', source_file: '/tmp/example.ts', file_type: 'code' }],
          edges: [],
        }),
      },
      { registry, classifySourceFile: () => 'code' },
    )

    expect(result.fragment.nodes).toHaveLength(1)
    expect(result.outcome).toEqual({
      filePath: '/tmp/example.ts',
      status: 'indexed',
      reason: 'indexed',
      capability: 'custom:extract:typescript',
    })
  })

  it('returns outcomes and emits source-safe diagnostics on the default path', () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-extraction-stages-'))
    try {
      const filePath = join(root, 'sample.ts')
      writeFileSync(
        filePath,
        readFileSync(join(process.cwd(), 'tests', 'fixtures', 'sample.ts'), 'utf8'),
        'utf8',
      )
      const callbackOutcomes: ExtractionFileOutcome[] = []
      const stageDiagnostics: ExtractionStageDiagnostic[] = []
      const result = extractWithPipelineResult([filePath], {
        onFileOutcome: (outcome) => callbackOutcomes.push(outcome),
        onStageDiagnostic: (diagnostic) => stageDiagnostics.push(diagnostic),
      })

      expect(result.data.nodes.length).toBeGreaterThan(0)
      expect(result.fileOutcomes).toEqual(callbackOutcomes)
      expect(result.fileOutcomes).toEqual([expect.objectContaining({
        filePath,
        status: 'indexed',
        capability: 'builtin:extract:typescript',
      })])
      expect(result.diagnostics).toEqual([])
      expect(new Set(stageDiagnostics.map((diagnostic) => diagnostic.stage))).toEqual(new Set([
        'discovery_outcome',
        'capability_selection',
        'per_language_extraction',
        'framework_augmentation',
        'fragment_merge',
        'cross_file_relationships',
        'diagnostics_projection',
      ]))
      expect(JSON.stringify(stageDiagnostics)).not.toContain(filePath)
      expect(JSON.stringify(stageDiagnostics)).not.toContain('HttpClient')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('captures file failures in the new result API without changing legacy extract behavior', () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-missing-pipeline-'))
    try {
      const missingFile = join(root, 'missing.ts')
      const result = extractWithPipelineResult([missingFile])

      expect(result.data).toMatchObject({ nodes: [], edges: [] })
      expect(result.fileOutcomes).toEqual([expect.objectContaining({
        filePath: missingFile,
        status: 'failed',
        reason: 'extractor_error',
        capability: 'builtin:extract:typescript',
      })])
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          filePath: missingFile,
          diagnostic: expect.objectContaining({ code: 'extractor_error', level: 'error' }),
        }),
      ])
      expect(() => extract([missingFile])).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('projects local parser diagnostics with their owning file outcome', () => {
    const outcomes: ExtractionFileOutcome[] = [{
      filePath: '/tmp/fallback.go',
      status: 'indexed_with_warnings',
      reason: 'parser_fallback',
      capability: 'builtin:extract:go',
      diagnostics: [{ code: 'parser_fallback', level: 'warning', message: 'local detail' }],
    }]

    expect(projectExtractionDiagnostics(outcomes)).toEqual([{
      filePath: '/tmp/fallback.go',
      status: 'indexed_with_warnings',
      reason: 'parser_fallback',
      capability: 'builtin:extract:go',
      diagnostic: outcomes[0]?.diagnostics?.[0],
    }])
  })

  it('keeps cross-file resolution independently callable', () => {
    expect(resolveCrossFileExtraction({
      files: [],
      data: { nodes: [], edges: [] },
    })).toEqual({ nodes: [], edges: [] })
  })
})
