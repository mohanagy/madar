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

  it('keeps neutral helper source before and after stronger file matches', () => {
    const { root, sourceFile } = createFixture()
    const sourceLines = [
      'export const combinePair = (left: number, right: number) => left + right',
      '',
      'export function keepDatum<T>(datum: T) {',
      '  return datum',
      '}',
      '',
      'export const polishText = (text: string) => text.trim().toUpperCase()',
      '',
      'export async function processRequest(payload: Payload) {',
      '  const validationResult = validateRequest(payload)',
      '  await insertRecord(validationResult)',
      '  await dispatchRecord(validationResult)',
      '  return retryDelivery(validationResult)',
      '}',
      '',
      'export const mergePair = (first: number, second: number) => first - second',
      '',
      'export function echoDatum<T>(datum: T) {',
      '  return datum',
      '}',
      '',
      'export const styleText = (text: string) => text.toLowerCase().trim()',
    ]
    const helpers = [
      {
        label: 'combinePair',
        sourceLocation: 'L1',
        expectedLine: 1,
        symbolRange: { start: 1, end: 1 },
      },
      {
        label: 'keepDatum',
        sourceLocation: 'L3-L5',
        expectedLine: 4,
        symbolRange: { start: 3, end: 5 },
      },
      {
        label: 'polishText',
        sourceLocation: 'L7',
        expectedLine: 7,
        symbolRange: { start: 7, end: 7 },
      },
      {
        label: 'mergePair',
        sourceLocation: 'L16',
        expectedLine: 16,
        symbolRange: { start: 16, end: 16 },
      },
      {
        label: 'echoDatum',
        sourceLocation: 'L18-L20',
        expectedLine: 19,
        symbolRange: { start: 18, end: 20 },
      },
      {
        label: 'styleText',
        sourceLocation: 'L22',
        expectedLine: 22,
        symbolRange: { start: 22, end: 22 },
      },
    ]
    try {
      writeFileSync(sourceFile, sourceLines.join('\n'), 'utf8')

      for (const helper of helpers) {
        const evidence = readQueryEvidenceSnippet(sourceFile, helper.symbolRange.start, {
          question: QUESTION,
          label: helper.label,
          sourceLocation: helper.sourceLocation,
        })

        expect(evidence).toMatchObject({ scope: 'source_file' })
        const snippet = evidence?.snippet ?? ''
        const renderedLines = evidence?.snippet.split('\n') ?? []
        expect(renderedLines.length).toBeLessThanOrEqual(4)
        expect(snippet.length).toBeLessThanOrEqual(300)

        const renderedLineNumbers = renderedLines.map((line) => {
          const match = /^L(\d+): (.*)$/.exec(line)
          expect(match).not.toBeNull()
          expect(match?.[2]?.length).toBeLessThanOrEqual(220)
          return Number(match?.[1])
        })
        expect(renderedLineNumbers).toEqual([...renderedLineNumbers].sort((left, right) => left - right))
        expect(evidence?.lineNumber).toBe(renderedLineNumbers[0])

        const expectedSource = sourceLines[helper.expectedLine - 1]!
          .replace(/\s+/g, ' ').trim()
        expect(renderedLines).toContain(`L${helper.expectedLine}: ${expectedSource}`)
        expect(
          renderedLineNumbers.filter((renderedLineNumber) => (
            renderedLineNumber >= helper.symbolRange.start
            && renderedLineNumber <= helper.symbolRange.end
          )),
        ).toEqual([helper.expectedLine])

        expect(renderedLines.some((line) => (
          line.includes('validateRequest')
          || line.includes('insertRecord')
          || line.includes('dispatchRecord')
          || line.includes('retryDelivery')
        ))).toBe(true)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reserves a late neutral helper under long preceding file-match pressure', () => {
    const { root, sourceFile } = createFixture()
    const strongLine = "export const processRequest = async (payload: Payload) => retryDelivery(await dispatchRecord(await insertRecord(validateRequest(sanitize(payload)), { insertionMode: 'durable', validationMode: 'strict', dispatchMode: 'ordered', retryMode: 'exponential', handlingMode: 'recorded' })))"
    const helperLine = "export const weaveTuple = (alpha: string, beta: string, gamma: string) => [alpha.trim(), beta.toUpperCase(), gamma.toLowerCase()].join(':')"
    const sourceLines = [strongLine, '', helperLine]
    try {
      writeFileSync(sourceFile, sourceLines.join('\n'), 'utf8')

      const evidence = readQueryEvidenceSnippet(sourceFile, 3, {
        question: QUESTION,
        label: 'weaveTuple',
        sourceLocation: 'L3',
      })

      expect(evidence).toEqual({
        snippet: `L3: ${helperLine}`,
        lineNumber: 3,
        scope: 'source_file',
      })
      const renderedLines = evidence?.snippet.split('\n') ?? []
      const renderedLineNumbers = renderedLines.map((line) => Number(/^L(\d+):/.exec(line)?.[1]))
      expect(renderedLineNumbers).toEqual([...renderedLineNumbers].sort((left, right) => left - right))
      expect(renderedLines.length).toBeLessThanOrEqual(4)
      expect(evidence?.snippet.length).toBeLessThanOrEqual(300)
      for (const line of renderedLines) {
        const content = /^L\d+: (.*)$/.exec(line)?.[1] ?? ''
        expect(content.length).toBeLessThanOrEqual(220)
      }
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
