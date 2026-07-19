import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(resolve(path), 'utf8')

const manifestGlob = (pattern: string): RegExp => {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', '\u0000')
    .replaceAll('*', '[^/]*')
    .replaceAll('\u0000', '.*')
  return new RegExp(`^${escaped}$`)
}

describe('core reset governance', () => {
  it('keeps one linked roadmap and RFC contract', () => {
    const roadmap = read('docs/roadmap.md')
    const design = read('docs/designs/2026-07-19-core-reset.md')
    const scorecard = read('docs/core-reset/scorecard.md')
    const readme = read('README.md')
    const contributing = read('CONTRIBUTING.md')

    expect(roadmap).toContain('# Public roadmap')
    expect(roadmap).toContain('issues/577')
    expect(roadmap).toContain('milestone/7')
    expect(roadmap).toContain('projects/8')
    expect(roadmap).toContain('removal-manifest.yml')
    expect(roadmap).toContain('scorecard.md')
    expect(roadmap).toContain('## Ready')
    expect(roadmap).toContain('## Next')
    expect(roadmap).toContain('## Later')
    expect(roadmap).toContain('accepted Core Reset')
    expect(roadmap).not.toContain('currently **proposed**')
    expect(roadmap).not.toMatch(/^##\s+v?\d+(?:\.\d+)+\b/im)
    expect(roadmap).not.toMatch(/^##\s+Features?\b/im)

    expect(design).toContain('issues/577')
    expect(design).toContain('**Status:** accepted')
    expect(design).toContain('not a permanent V1/V2 split')
    expect(design).toContain('Merging code alone is not completion')
    expect(scorecard).toContain('**Status:** accepted')
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
        sources?: string[]
        exit_gate: string
        remove_when?: string
      }>
    }

    expect(manifest.schema_version).toBe(1)
    expect(manifest.status).toBe('accepted')
    expect(manifest.rules.length).toBeGreaterThan(0)
    expect(manifest.items.length).toBeGreaterThan(10)

    const ids = manifest.items.map((item) => item.id.trim())
    expect(new Set(ids).size).toBe(ids.length)

    for (const item of manifest.items) {
      expect(item.id.trim().length).toBeGreaterThan(0)
      expect(['keep', 'rebuild', 'move', 'delete', 'defer']).toContain(item.disposition)
      expect(['proposed', 'planned', 'in_progress', 'complete', 'approved_exception']).toContain(item.status)
      expect(item.exit_gate.trim().length).toBeGreaterThan(0)
      for (const source of item.sources ?? []) {
        expect(source.trim()).toMatch(/^(?:\.github|docs|examples|src|tests|tools)\//)
      }
      if (item.disposition === 'rebuild') {
        expect(item.remove_when?.trim().length).toBeGreaterThan(0)
      }
    }
  })

  it('assigns every production TypeScript file to exactly one removal-manifest item', () => {
    const manifest = parse(read('docs/core-reset/removal-manifest.yml')) as {
      review: {
        status: string
        production_files_reviewed: number
        files_with_one_owner: number
        unowned_files: number
        overlapping_files: number
        disposition_changes: number
      }
      items: Array<{ id: string; sources?: string[] }>
    }
    const productionFiles = execFileSync('git', ['ls-files', 'src/**/*.ts'], {
      encoding: 'utf8',
    }).trim().split('\n').filter(Boolean)

    expect(productionFiles).toHaveLength(181)
    for (const file of productionFiles) {
      const owners = manifest.items.filter((item) =>
        (item.sources ?? []).some((pattern) => manifestGlob(pattern).test(file)))
      expect(owners.map((item) => item.id), `${file} must have exactly one owner`).toHaveLength(1)
    }
    expect(manifest.review).toMatchObject({
      status: 'complete',
      production_files_reviewed: 181,
      files_with_one_owner: 181,
      unowned_files: 0,
      overlapping_files: 0,
      disposition_changes: 0,
    })
  })

  it('routes contributors through the reset contract', () => {
    const issueConfig = read('.github/ISSUE_TEMPLATE/config.yml')
    const workItem = parse(read('.github/ISSUE_TEMPLATE/core_reset_work_item.yml')) as {
      body: Array<{
        id?: string
        validations?: { required?: boolean }
        attributes?: { options?: Array<{ required?: boolean }> }
      }>
    }
    const pullRequestTemplate = read('.github/pull_request_template.md')

    expect(issueConfig).toContain('/blob/main/docs/roadmap.md')
    expect(issueConfig).not.toContain('/issues/155')

    const requiredFieldIds = [
      'parent',
      'problem',
      'manifest',
      'dependencies',
      'implementation',
      'deletion',
      'budget',
      'gates',
      'verification',
      'non_goals',
    ]
    for (const id of requiredFieldIds) {
      expect(workItem.body.find((field) => field.id === id)?.validations?.required).toBe(true)
    }
    const resetContract = workItem.body.find((field) => field.id === 'reset_contract')
    expect(resetContract?.attributes?.options?.length).toBeGreaterThan(0)
    expect(resetContract?.attributes?.options?.every((option) => option.required)).toBe(true)

    expect(pullRequestTemplate).toContain('## Core Reset contract')
    expect(pullRequestTemplate).toContain('Removal-manifest IDs')
    expect(pullRequestTemplate).toContain('Net production LOC')
  })
})
