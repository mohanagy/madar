import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { readQueryEvidenceSnippet } from '../../src/runtime/retrieve.js'

const QUESTION = 'How does sanitize input lead to request validation and insertion, then dispatch with retry handling?'

function createFixture(): { root: string; sourceFile: string } {
  const fixtureParent = resolve('out', 'test-runtime')
  mkdirSync(fixtureParent, { recursive: true })
  const root = mkdtempSync(join(fixtureParent, 'madar-source-preservation-'))
  const sourceFile = join(root, 'processing.ts')
  return { root, sourceFile }
}

describe('query evidence source preservation', () => {
  it('keeps complete one-line symbol evidence beside stronger same-file matches', () => {
    const { root, sourceFile } = createFixture()
    const sourceLines = [
      'export const foldValue = (value: string) => sanitize(value)',
      'export const wrapValue = (value: string) => sanitize(`[${value}]`)',
      '',
      'export async function processRequest(payload: Payload) {',
      '  const validationResult = validateRequest(payload)',
      '  await insertRecord(validationResult)',
      '  await dispatchRecord(validationResult)',
      '  return retryDelivery(validationResult)',
      '}',
    ]
    try {
      writeFileSync(sourceFile, sourceLines.join('\n'), 'utf8')

      for (const [lineNumber, label] of [[1, 'foldValue'], [2, 'wrapValue']] as const) {
        const evidence = readQueryEvidenceSnippet(sourceFile, lineNumber, {
          question: QUESTION,
          label,
          sourceLocation: `L${lineNumber}`,
        })

        expect(evidence).toMatchObject({ scope: 'source_file' })
        expect(evidence?.snippet).toContain(`L${lineNumber}: ${sourceLines[lineNumber - 1]}`)
        expect(evidence?.snippet).toContain('dispatchRecord')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps selected implementation evidence from a short multiline symbol', () => {
    const { root, sourceFile } = createFixture()
    try {
      writeFileSync(sourceFile, [
        'export function shapeValue(value: string) {',
        '  const output = sanitize(value)',
        '  return output',
        '}',
        '',
        'export async function processRequest(payload: Payload) {',
        '  const validationResult = validateRequest(payload)',
        '  await insertRecord(validationResult)',
        '  await dispatchRecord(validationResult)',
        '  return retryDelivery(validationResult)',
        '}',
      ].join('\n'), 'utf8')

      const evidence = readQueryEvidenceSnippet(sourceFile, 1, {
        question: QUESTION,
        label: 'shapeValue',
        sourceLocation: 'L1-L4',
      })

      expect(evidence).toMatchObject({ scope: 'source_file' })
      expect(evidence?.snippet).toContain('L2: const output = sanitize(value)')
      expect(evidence?.snippet).toContain('dispatchRecord')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves a helper-only split-file excerpt unchanged', () => {
    const { root, sourceFile } = createFixture()
    const helperLine = 'export const foldValue = (value: string) => sanitize(value)'
    try {
      writeFileSync(sourceFile, helperLine, 'utf8')
      writeFileSync(join(root, 'workflow.ts'), [
        'const validationResult = validateRequest(payload)',
        'await insertRecord(validationResult)',
        'await dispatchRecord(validationResult)',
        'return retryDelivery(validationResult)',
      ].join('\n'), 'utf8')

      const evidence = readQueryEvidenceSnippet(sourceFile, 1, {
        question: QUESTION,
        label: 'foldValue',
        sourceLocation: 'L1',
      })

      expect(evidence).toEqual({
        snippet: `L1: ${helperLine}`,
        lineNumber: 1,
        scope: 'symbol',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
