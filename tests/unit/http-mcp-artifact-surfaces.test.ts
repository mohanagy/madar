import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { GRAPH_ARTIFACT_V2_HEADER } from '../../src/contracts/graph-artifact.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { startGraphServer } from '../../src/runtime/http-server.js'
import { resourcesForGraph } from '../../src/runtime/stdio/resources.js'

const SILENT = { log: () => undefined, error: () => undefined }

function cutOverWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'surfaces-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), 'export function alpha() { beta() }\nexport function beta() {}\n')
  generateGraph(root, { noHtml: true })
  return root
}

describe('HTTP serves the canonical artifact and retires the legacy route', () => {
  let root: string
  let handle: Awaited<ReturnType<typeof startGraphServer>>
  let base: string

  beforeAll(async () => {
    root = cutOverWorkspace()
    handle = await startGraphServer({
      graphPath: join(root, 'out', 'graph.madar'),
      port: 0,
      logger: SILENT,
    })
    base = handle.url.replace(/\/$/, '')
  })

  afterAll(async () => {
    await handle.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('serves graph.madar with a vendor media type, not application/json', async () => {
    const response = await fetch(`${base}/graph.madar`)
    const body = await response.text()

    expect(response.status).toBe(200)
    // A v2 artifact is a header followed by JSON. Labelling it application/json
    // invites a client to parse the whole body and fail.
    expect(response.headers.get('content-type')).toMatch(/vnd\.madar\.graph-artifact\.v2/)
    expect(response.headers.get('content-type')).not.toMatch(/application\/json/)
    expect(body.startsWith(GRAPH_ARTIFACT_V2_HEADER)).toBe(true)
    expect(body).toBe(readFileSync(join(root, 'out', 'graph.madar'), 'utf8'))
  })

  it('answers the legacy route with 410 and no redirect', async () => {
    const response = await fetch(`${base}/graph.json`, { redirect: 'manual' })

    // Gone rather than moved: a redirect would hand a v1 client a v2 body it
    // cannot parse, so the request must be reported as unsatisfiable.
    expect(response.status).toBe(410)
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('content-type')).toMatch(/application\/problem\+json/)
  })

  it('explains the retirement in machine-readable form', async () => {
    const problem = await (await fetch(`${base}/graph.json`)).json() as Record<string, unknown>

    expect(problem.status).toBe(410)
    expect(problem.type).toMatch(/graph-artifact-moved/)
    expect(String(problem.detail)).toMatch(/graph\.madar/)
    expect(problem.canonical_path).toBe('/graph.madar')
  })

  it('never serves the tombstone bytes as a graph', async () => {
    const body = await (await fetch(`${base}/graph.json`)).text()

    expect(body).not.toContain('MADAR_GRAPH_MOVED/')
  })
})

describe('a workspace that never cut over keeps its v1 route', () => {
  let root: string
  let handle: Awaited<ReturnType<typeof startGraphServer>>

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'surfaces-legacy-http-'))
    const out = join(root, 'out')
    mkdirSync(out, { recursive: true })
    writeFileSync(
      join(out, 'graph.json'),
      JSON.stringify({ schema_version: 1, directed: true, nodes: [{ id: 'a', label: 'A' }], links: [] }),
    )
    handle = await startGraphServer({ graphPath: join(out, 'graph.json'), port: 0, logger: SILENT })
  })

  afterAll(async () => {
    await handle.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('serves the v1 artifact rather than retiring it', async () => {
    const response = await fetch(`${handle.url}graph.json`)

    // Nothing has moved here. Answering 410 would retire an artifact that is
    // present and correct, breaking every legacy workspace.
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/application\/json/)
    expect(JSON.parse(await response.text()).schema_version).toBe(1)
  })

  it('reports the canonical route as absent, not as an error', async () => {
    expect((await fetch(`${handle.url}graph.madar`)).status).toBe(404)
  })
})

describe('MCP exposes the artifact that the workspace actually has', () => {
  it('advertises graph.madar for a cut-over workspace', () => {
    const root = cutOverWorkspace()
    try {
      const resources = resourcesForGraph(join(root, 'out', 'graph.madar'))
      const graph = resources.find((entry) => entry.uri.endsWith('graph.madar'))

      expect(graph).toBeDefined()
      expect(graph?.mimeType).toBe('application/vnd.madar.graph-artifact.v2')
      expect(resources.some((entry) => entry.uri.endsWith('graph.json'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps serving the v1 resource for a workspace that never cut over', () => {
    const root = mkdtempSync(join(tmpdir(), 'surfaces-legacy-'))
    const out = join(root, 'out')
    mkdirSync(out, { recursive: true })
    writeFileSync(
      join(out, 'graph.json'),
      JSON.stringify({ schema_version: 1, directed: true, nodes: [{ id: 'a' }], links: [] }),
    )

    try {
      // Nothing has moved here, so stripping the resource would take a legacy
      // workspace's graph away rather than migrate it.
      const resources = resourcesForGraph(join(out, 'graph.json'))
      const graph = resources.find((entry) => entry.uri.endsWith('graph.json'))

      expect(graph).toBeDefined()
      expect(graph?.mimeType).toBe('application/json')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
