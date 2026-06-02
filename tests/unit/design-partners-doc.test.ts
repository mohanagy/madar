import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('design partner program docs', () => {
  it('publishes a share-safe design partner guide, tracker, and issue template', () => {
    const guide = readFileSync(resolve('docs/design-partners.md'), 'utf8')
    const template = readFileSync(resolve('.github/ISSUE_TEMPLATE/design_partner_report.yml'), 'utf8')
    const readme = readFileSync(resolve('README.md'), 'utf8')
    const gettingStarted = readFileSync(resolve('docs/tutorials/getting-started.md'), 'utf8')
    const trackerRows = guide
      .split('\n')
      .filter((line) => /^\| DP-/.test(line))

    expect(guide).toContain('# Design partners')
    expect(guide).toContain('## Share-safe boundary')
    expect(guide).toContain('Do not include source paths')
    expect(guide).toContain('Do not include source code')
    expect(guide).toContain('better')
    expect(guide).toContain('neutral')
    expect(guide).toContain('worse')
    expect(guide).toContain('design-partner')
    expect(guide).toContain('type:product')
    expect(guide).toContain('## Public tracker')
    expect(trackerRows).toHaveLength(10)

    expect(template).toContain('name: Design partner report')
    expect(template).toContain('design-partner')
    expect(template).toContain('repo_size_bucket')
    expect(template).toContain('framework')
    expect(template).toContain('description: "Example: NestJS + Prisma, Next.js app router, Express API, monorepo service + web."')
    expect(template).toContain('agent')
    expect(template).toContain('task_type')
    expect(template).toContain('baseline_commands')
    expect(template).toContain('madar_commands')
    expect(template).toContain('better')
    expect(template).toContain('neutral')
    expect(template).toContain('worse')
    expect(template).toContain('caveats')
    expect(template).toContain('follow_up_issues')
    expect(template).toContain('Do not include source paths')
    expect(template).toContain('Do not include source code')

    expect(readme).toContain('docs/design-partners.md')
    expect(gettingStarted).toContain('docs/design-partners.md')
  })
})
