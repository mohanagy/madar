import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildFromJson } from '../../src/pipeline/build.js'
import { extract } from '../../src/pipeline/extract.js'

function createSandbox(): string {
  return mkdtempSync(join(tmpdir(), 'madar-extract-duplicate-stems-'))
}

function writeFile(root: string, relPath: string, content: string): string {
  const absPath = join(root, relPath)
  mkdirSync(join(absPath, '..'), { recursive: true })
  writeFileSync(absPath, content, 'utf8')
  return absPath
}

function relativeSource(root: string, sourceFile: unknown): string {
  return relative(root, String(sourceFile ?? '')).replaceAll('\\', '/')
}

describe('extract duplicate file stems', () => {
  it('keeps duplicate route.ts and link.ts files distinct in the built graph', () => {
    const sandbox = createSandbox()
    try {
      const files = [
        writeFile(sandbox, 'apps/web/app/api/a/route.ts', 'export function GET() { return new Response() }\n'),
        writeFile(sandbox, 'apps/web/app/api/b/route.ts', 'export function POST() { return new Response() }\n'),
        writeFile(sandbox, 'apps/web/lib/middleware/link.ts', 'export function LinkMiddleware() { return null }\n'),
        writeFile(sandbox, 'apps/web/ui/shared/icons/link.tsx', 'export function Link() { return null }\n'),
      ].map((filePath) => resolve(filePath))

      const graph = buildFromJson(extract(files), { directed: true })
      const nodes = [...graph.nodeEntries()].map(([id, attrs]) => ({
        id,
        label: String(attrs.label ?? ''),
        source_file: String(attrs.source_file ?? ''),
      }))

      const routeFileNodes = nodes.filter((node) => node.label === 'route.ts')
      expect(routeFileNodes).toHaveLength(2)
      expect(new Set(routeFileNodes.map((node) => node.id)).size).toBe(2)
      expect(routeFileNodes.map((node) => relativeSource(sandbox, node.source_file)).sort()).toEqual([
        'apps/web/app/api/a/route.ts',
        'apps/web/app/api/b/route.ts',
      ])

      const linkFileNodes = nodes.filter((node) => node.label === 'link.ts' || node.label === 'link.tsx')
      expect(linkFileNodes).toHaveLength(2)
      expect(new Set(linkFileNodes.map((node) => node.id)).size).toBe(2)
      expect(linkFileNodes.map((node) => relativeSource(sandbox, node.source_file)).sort()).toEqual([
        'apps/web/lib/middleware/link.ts',
        'apps/web/ui/shared/icons/link.tsx',
      ])

      expect(nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          label: 'LinkMiddleware()',
          source_file: expect.stringContaining('/apps/web/lib/middleware/link.ts'),
        }),
      ]))
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it('keeps duplicate controller.ts and route.ts imports bound to the correct file-local symbols', () => {
    const sandbox = createSandbox()
    try {
      const files = [
        writeFile(sandbox, 'apps/web/app/api/a/controller.ts', 'export function handle() { return "a" }\n'),
        writeFile(sandbox, 'apps/web/app/api/a/route.ts', [
          'import { handle } from "./controller"',
          'export function POST() { return handle() }',
        ].join('\n') + '\n'),
        writeFile(sandbox, 'apps/web/app/api/b/controller.ts', 'export function handle() { return "b" }\n'),
        writeFile(sandbox, 'apps/web/app/api/b/route.ts', [
          'import { handle } from "./controller"',
          'export function POST() { return handle() }',
        ].join('\n') + '\n'),
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

      const postA = nodes.find((node) =>
        node.label === 'POST()' && relativeSource(sandbox, node.source_file) === 'apps/web/app/api/a/route.ts',
      )
      const postB = nodes.find((node) =>
        node.label === 'POST()' && relativeSource(sandbox, node.source_file) === 'apps/web/app/api/b/route.ts',
      )
      const handleA = nodes.find((node) =>
        node.label === 'handle()' && relativeSource(sandbox, node.source_file) === 'apps/web/app/api/a/controller.ts',
      )
      const handleB = nodes.find((node) =>
        node.label === 'handle()' && relativeSource(sandbox, node.source_file) === 'apps/web/app/api/b/controller.ts',
      )

      expect(postA).toBeDefined()
      expect(postB).toBeDefined()
      expect(handleA).toBeDefined()
      expect(handleB).toBeDefined()
      expect(postA?.id).not.toBe(postB?.id)
      expect(handleA?.id).not.toBe(handleB?.id)

      expect(edges).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: postA?.id, target: handleA?.id, relation: 'calls' }),
        expect.objectContaining({ source: postB?.id, target: handleB?.id, relation: 'calls' }),
      ]))
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it('keeps duplicate-stem relative imports bound to retained context during incremental extraction', () => {
    const sandbox = createSandbox()
    try {
      const routeA = writeFile(sandbox, 'apps/web/app/api/a/route.ts', [
        'import { handle } from "./controller"',
        'export function POST() { return handle() }',
      ].join('\n') + '\n')
      const controllerA = writeFile(sandbox, 'apps/web/app/api/a/controller.ts', 'export function handle() { return "a" }\n')
      const routeB = writeFile(sandbox, 'apps/web/app/api/b/route.ts', [
        'import { handle } from "./controller"',
        'export function POST() { return handle() }',
      ].join('\n') + '\n')
      const controllerB = writeFile(sandbox, 'apps/web/app/api/b/controller.ts', 'export function handle() { return "b" }\n')
      const files = [routeA, controllerA, routeB, controllerB].map((filePath) => resolve(filePath))

      const fullExtraction = extract(files)
      const retainedNodes = fullExtraction.nodes.filter((node) => resolve(node.source_file) !== resolve(routeA))
      const changedExtraction = extract([resolve(routeA)], {
        allowedTargets: files,
        contextNodes: retainedNodes,
      })

      const changedPost = changedExtraction.nodes.find((node) =>
        node.label === 'POST()' && relativeSource(sandbox, node.source_file) === 'apps/web/app/api/a/route.ts',
      )
      const retainedHandleA = retainedNodes.find((node) =>
        node.label === 'handle()' && relativeSource(sandbox, node.source_file) === 'apps/web/app/api/a/controller.ts',
      )
      const retainedHandleB = retainedNodes.find((node) =>
        node.label === 'handle()' && relativeSource(sandbox, node.source_file) === 'apps/web/app/api/b/controller.ts',
      )

      expect(changedPost).toBeDefined()
      expect(retainedHandleA).toBeDefined()
      expect(retainedHandleB).toBeDefined()
      expect(changedExtraction.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source: changedPost?.id,
          target: retainedHandleA?.id,
          relation: 'calls',
        }),
      ]))
      expect(changedExtraction.edges).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          source: changedPost?.id,
          target: retainedHandleB?.id,
          relation: 'calls',
        }),
      ]))
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})
