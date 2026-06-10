import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildFromJson } from '../../src/pipeline/build.js'
import { extract } from '../../src/pipeline/extract.js'
import { retrieveContext } from '../../src/runtime/retrieve.js'

function createSandbox(): string {
  return mkdtempSync(join(tmpdir(), 'madar-extract-alias-runtime-proof-'))
}

function writeFile(root: string, relPath: string, content: string): string {
  const absPath = join(root, relPath)
  mkdirSync(dirname(absPath), { recursive: true })
  writeFileSync(absPath, content, 'utf8')
  return absPath
}

function relativeSource(root: string, sourceFile: unknown): string {
  return relative(root, String(sourceFile ?? '')).replaceAll('\\', '/')
}

describe('extract JS/TS path aliases for runtime proof', () => {
  it('resolves aliased barrel imports and surfaces external imported member calls', () => {
    const sandbox = createSandbox()
    try {
      writeFile(
        sandbox,
        'apps/web/tsconfig.json',
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: {
              '@/*': ['./*'],
            },
          },
        }, null, 2) + '\n',
      )

      const files = [
        writeFile(
          sandbox,
          'apps/web/middleware.ts',
          [
            'import { LinkMiddleware } from "./lib/middleware/link"',
            '',
            'export async function middleware(ev: { waitUntil(value: Promise<unknown>): void }) {',
            '  return LinkMiddleware(ev)',
            '}',
          ].join('\n') + '\n',
        ),
        writeFile(
          sandbox,
          'apps/web/lib/middleware/link.ts',
          [
            'import { NextResponse } from "next/server"',
            'import { recordClick } from "@/lib/tinybird"',
            'import { getFinalUrl } from "./utils/get-final-url"',
            '',
            'export async function LinkMiddleware(ev: { waitUntil(value: Promise<unknown>): void }) {',
            '  ev.waitUntil(recordClick())',
            '  const finalUrl = getFinalUrl("https://example.com")',
            '  return NextResponse.redirect(finalUrl)',
            '}',
          ].join('\n') + '\n',
        ),
        writeFile(
          sandbox,
          'apps/web/lib/middleware/utils/get-final-url.ts',
          [
            'export function getFinalUrl(url: string) {',
            '  return url',
            '}',
          ].join('\n') + '\n',
        ),
        writeFile(
          sandbox,
          'apps/web/lib/tinybird/index.ts',
          'export { recordClick } from "./record-click"\n',
        ),
        writeFile(
          sandbox,
          'apps/web/lib/tinybird/record-click.ts',
          [
            'export async function recordClick() {',
            '  return true',
            '}',
          ].join('\n') + '\n',
        ),
      ].map((filePath) => resolve(filePath))

      const graph = buildFromJson(extract(files), { directed: true })
      const nodes = [...graph.nodeEntries()].map(([id, attrs]) => ({
        id,
        label: String(attrs.label ?? ''),
        source_file: String(attrs.source_file ?? ''),
      }))
      const edges = [...graph.edgeEntries()].map(([source, target, attrs]) => ({
        source,
        target,
        relation: String(attrs.relation ?? ''),
      }))

      const middleware = nodes.find((node) =>
        node.label === 'middleware()' && relativeSource(sandbox, node.source_file) === 'apps/web/middleware.ts',
      )
      const linkMiddleware = nodes.find((node) =>
        node.label === 'LinkMiddleware()' && relativeSource(sandbox, node.source_file) === 'apps/web/lib/middleware/link.ts',
      )
      const recordClick = nodes.find((node) =>
        node.label === 'recordClick()' && relativeSource(sandbox, node.source_file) === 'apps/web/lib/tinybird/record-click.ts',
      )
      const redirectEffect = nodes.find((node) =>
        node.label === 'NextResponse.redirect' && relativeSource(sandbox, node.source_file) === 'apps/web/lib/middleware/link.ts',
      )

      expect(middleware).toBeDefined()
      expect(linkMiddleware).toBeDefined()
      expect(recordClick).toBeDefined()
      expect(redirectEffect).toBeDefined()
      expect(edges).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: middleware?.id, target: linkMiddleware?.id, relation: 'calls' }),
        expect.objectContaining({ source: linkMiddleware?.id, target: recordClick?.id, relation: 'calls' }),
        expect.objectContaining({ source: linkMiddleware?.id, target: redirectEffect?.id, relation: 'calls' }),
      ]))

      const prompt = 'How does Dub resolve a short-link click from request handling through analytics tracking and destination redirect?'
      const retrieval = retrieveContext(graph, {
        question: prompt,
        budget: 3000,
        taskKind: 'explain',
        retrievalStrategy: 'slice-v1',
        runtimeProofProfile: {
          prompt,
          strict_runtime_proof: true,
          expected_spi: false,
          obligations: [
            { id: 'request_handling', label: 'request handling', kind: 'entrypoint', evidence_terms: ['request', 'route', 'handler', 'click', 'middleware'] },
            { id: 'analytics_tracking', label: 'analytics tracking', kind: 'terminal', evidence_terms: ['analytics', 'track', 'click'] },
            { id: 'destination_redirect', label: 'destination redirect', kind: 'terminal', evidence_terms: ['redirect', 'destination', 'location'] },
          ],
        },
      })

      expect(retrieval.execution_slice?.status).toBe('complete')
      expect(retrieval.answer_contract?.runtime_proof).toEqual(expect.objectContaining({
        missing_obligations: [],
        obligations: expect.arrayContaining([
          expect.objectContaining({
            id: 'request_handling',
            evidence: expect.arrayContaining([expect.objectContaining({ label: 'LinkMiddleware()' })]),
          }),
          expect.objectContaining({
            id: 'analytics_tracking',
            evidence: expect.arrayContaining([expect.objectContaining({ label: 'recordClick()' })]),
          }),
          expect.objectContaining({
            id: 'destination_redirect',
            evidence: expect.arrayContaining([expect.objectContaining({ label: 'NextResponse.redirect' })]),
          }),
        ]),
      }))
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})
