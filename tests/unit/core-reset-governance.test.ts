import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(resolve(path), 'utf8')

describe('core reset governance', () => {
  it('keeps one linked roadmap and RFC contract', () => {
    const roadmap = read('docs/roadmap.md')
    const design = read('docs/designs/2026-07-19-core-reset.md')
    const readme = read('README.md')
    const contributing = read('CONTRIBUTING.md')

    expect(roadmap).toContain('# Public roadmap')
    expect(roadmap).toContain('issues/577')
    expect(roadmap).toContain('milestone/7')
    expect(roadmap).toContain('projects/8')
    expect(roadmap).toContain('removal-manifest.yml')
    expect(roadmap).toContain('scorecard.md')
    expect(roadmap).toContain('## Now')
    expect(roadmap).toContain('## Next')
    expect(roadmap).toContain('## Later')
    expect(roadmap).not.toContain('## v0.26')

    expect(design).toContain('issues/577')
    expect(design).toContain('not a permanent V1/V2 split')
    expect(design).toContain('Merging code alone is not completion')
    expect(readme).toContain('docs/roadmap.md')
    expect(contributing).toContain('docs/roadmap.md')
  })

  it('keeps the removal manifest machine-readable and explicit', () => {
    const manifestPath = 'docs/core-reset/removal-manifest.yml'
    expect(existsSync(resolve(manifestPath))).toBe(true)

    const manifest = parse(read(manifestPath)) as {
      schema_version: number
      status: string
      rules: string[]
      items: Array<{
        id: string
        disposition: string
        status: string
        exit_gate: string
        remove_when?: string
      }>
    }

    expect(manifest.schema_version).toBe(1)
    expect(manifest.status).toBe('proposed')
    expect(manifest.rules.length).toBeGreaterThan(0)
    expect(manifest.items.length).toBeGreaterThan(10)

    const ids = manifest.items.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)

    for (const item of manifest.items) {
      expect(['keep', 'rebuild', 'move', 'delete', 'defer']).toContain(item.disposition)
      expect(['proposed', 'planned', 'in_progress', 'complete', 'approved_exception']).toContain(item.status)
      expect(item.exit_gate.length).toBeGreaterThan(0)
      if (item.disposition === 'rebuild') {
        expect(item.remove_when?.length).toBeGreaterThan(0)
      }
    }
  })

  it('routes contributors through the reset contract', () => {
    const issueConfig = read('.github/ISSUE_TEMPLATE/config.yml')
    const pullRequestTemplate = read('.github/pull_request_template.md')

    expect(issueConfig).toContain('/blob/main/docs/roadmap.md')
    expect(issueConfig).not.toContain('/issues/155')

    expect(pullRequestTemplate).toContain('## Core Reset contract')
    expect(pullRequestTemplate).toContain('Removal-manifest IDs')
    expect(pullRequestTemplate).toContain('Net production LOC')
  })
})
