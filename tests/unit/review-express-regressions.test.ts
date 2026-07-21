import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { buildCanonicalTypeScriptIndex } from '../../src/adapters/typescript/index.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function indexExpressSource(source: string) {
  const root = mkdtempSync(join(tmpdir(), 'madar-review-express-'))
  roots.push(root)
  const file = join(root, 'server.ts')
  writeFileSync(file, source, 'utf8')

  const result = buildCanonicalTypeScriptIndex({ root, files: [file] })
  const nodes = new Map(result.graph.nodeEntries())
  const routeEdges = result.graph.edgeEntries()
    .filter(([, , attributes]) => attributes.relation === 'route_handler')
    .map(([from, to, attributes]) => ({
      fromId: from,
      from: nodes.get(from),
      toId: to,
      to: nodes.get(to),
      attributes,
    }))

  return { nodes, routeEdges }
}

describe('CodeRabbit Express canonical-index regressions', () => {
  it('keeps multiple inline middleware handlers on one line as distinct symbols and edges', () => {
    const { nodes, routeEdges } = indexExpressSource([
      `import express from 'express'`,
      'export const app = express()',
      'app.use((_request, _response, next) => next(), (_request, _response, next) => next())',
    ].join('\n'))

    const middleware = [...nodes.entries()].filter(([, attributes]) =>
      attributes.framework_role === 'express_middleware')

    expect(middleware).toHaveLength(2)
    expect(new Set(middleware.map(([id]) => id))).toHaveLength(2)
    expect(middleware.map(([, attributes]) => attributes.qualified_name)).toEqual([
      expect.stringMatching(/^app\.use\.L3\.C\d+$/),
      expect.stringMatching(/^app\.use\.L3\.C\d+$/),
    ])
    expect(routeEdges).toHaveLength(2)
    expect(new Set(routeEdges.map((edge) => edge.toId))).toHaveLength(2)
  })

  it('recognizes a callable Express namespace import as the app factory', () => {
    const { nodes, routeEdges } = indexExpressSource([
      `import * as express from 'express'`,
      'export const app = express()',
      `app.get('/health', (_request, _response) => undefined)`,
    ].join('\n'))

    const app = [...nodes.values()].find((attributes) => attributes.qualified_name === 'app')
    expect(app).toMatchObject({ framework: 'express', framework_role: 'express_app' })
    expect(routeEdges).toHaveLength(1)
    expect(routeEdges[0]?.from?.qualified_name).toBe('app')
    expect(routeEdges[0]?.to).toMatchObject({
      framework: 'express',
      framework_role: 'express_route',
      route_path: '/health',
      http_method: 'GET',
    })
  })
})
