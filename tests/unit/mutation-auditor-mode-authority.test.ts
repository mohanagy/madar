import { createHash } from 'node:crypto'
import { readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  copyMatrix,
  discardMatrix,
  matrixDir,
  produceEvidenceMatrix,
  TEST_NAME,
} from './helpers/evidence-matrix.js'

/**
 * Who decides how strictly the evidence is audited.
 *
 * An independent reviewer copied genuine 25-failure evidence, kept the
 * declaration and the nested exact-set result intact, changed only the stored
 * `scoring.attribution_mode` to `owning_test`, removed one genuine failed
 * assertion, and truthfully rebound every report authority. The standalone
 * auditor passed with zero problems and produced the *same* semantic digest as
 * truthful evidence.
 *
 * The cause was that the auditor asked the scorer's own output which rules to
 * apply. That is the same mistake as trusting the scorer's verdict, one level
 * up: the previous round moved trust off the `equal` boolean and left it on the
 * mode selector beside it.
 *
 * So authority now comes from `meta.json`, which declares what a mutant must
 * prove, and every other persisted representation is validated against it
 * rather than consulted. These controls run against evidence the real harness
 * produced, because a hand-assembled artifact would not have exposed the gap
 * either.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const AUDITOR = resolve(REPO, 'scripts/audit-mutation-evidence.mjs')

let project = ''
let goldenRun = ''
const copies: string[] = []

beforeAll(() => {
  // Declared exact-set, exactly as the real shared-policy mutant is.
  const produced = produceEvidenceMatrix({ exactFailureSet: true })
  project = produced.project
  goldenRun = produced.runRoot
}, 60_000)

afterAll(() => {
  for (const dir of copies.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (project !== '') discardMatrix(project)
})

/** A private copy of the golden matrix with timestamps intact. */
function matrix(): string {
  const root = copyMatrix(goldenRun)
  copies.push(dirname(root))
  return root
}

const readJson = (dir: string, file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(dir, file), 'utf8')) as Record<string, unknown>

const edit = (dir: string, file: string, change: (value: Record<string, unknown>) => void): void => {
  const value = readJson(dir, file)
  change(value)
  writeFileSync(resolve(dir, file), JSON.stringify(value, null, 2))
}

/**
 * Rebinds every report authority after a control rewrites the report.
 *
 * Without this the control would be caught by the digest binding or the
 * invocation-window check and would prove nothing about attribution. The
 * reviewer's reproduction rebound these too; a control that skipped it would be
 * strictly weaker than the attack it claims to cover.
 */
function restamp(dir: string): void {
  const bytes = readFileSync(resolve(dir, 'vitest-report.json'))
  edit(dir, 'report-identity.json', (identity) => {
    identity['report_digest'] = createHash('sha256').update(bytes).digest('hex')
    identity['report_bytes'] = bytes.byteLength
  })
  const started = Date.parse(String(readJson(dir, 'report-identity.json')['invocation_started_at'])) / 1000
  utimesSync(resolve(dir, 'vitest-report.json'), started, started)
}

interface AuditResult {
  readonly status: number | null
  readonly codes: readonly string[]
  readonly digest: string | null
}

function audit(root: string): AuditResult {
  const child = spawnSync(process.execPath, [
    AUDITOR, root, '--expect-mutants', '1', '--expect-baselines', '1',
  ], { cwd: project, encoding: 'utf8' })
  const output = `${child.stdout ?? ''}${child.stderr ?? ''}`
  return {
    status: child.status,
    codes: [...output.matchAll(/\[([a-z_]+)\]/g)].map((match) => match[1] as string),
    digest: /semantic audit digest\s+([0-9a-f]{64})/.exec(output)?.[1] ?? null,
  }
}

/** The digest the auditor derives, available even when the audit fails. */
function digestOf(root: string): string {
  const out = resolve(dirname(root), `digest-${Math.random().toString(36).slice(2)}.json`)
  spawnSync(process.execPath, [AUDITOR, root, '--json', out], { cwd: project, encoding: 'utf8' })
  const parsed = JSON.parse(readFileSync(out, 'utf8')) as { semantic_audit_digest: string }
  return parsed.semantic_audit_digest
}

const mutantDir = (root: string): string => matrixDir(root, 'mutant')

describe('7.1 — truthful exact-set evidence', () => {
  it('declares exact_failure_set in the durable declaration', () => {
    const root = matrix()
    expect(readJson(mutantDir(root), 'meta.json')['attribution_mode']).toBe('exact_failure_set')
    expect(readJson(mutantDir(root), 'scoring.json')['attribution_mode']).toBe('exact_failure_set')
  })

  it('passes', () => {
    const result = audit(matrix())
    expect(result.status).toBe(0)
    expect(result.codes).toEqual([])
  })
})

describe('7.2 — permuted truthful evidence', () => {
  it('digests identically when only the report order changes', () => {
    // Order is not meaning. A digest that moved here would make every
    // comparison between two truthful matrices meaningless.
    const truthful = matrix()
    const permuted = matrix()
    const dir = mutantDir(permuted)
    const report = JSON.parse(readFileSync(resolve(dir, 'vitest-report.json'), 'utf8')) as {
      testResults: Array<{ assertionResults: unknown[] }>
    }
    for (const suite of report.testResults) suite.assertionResults.reverse()
    writeFileSync(resolve(dir, 'vitest-report.json'), JSON.stringify(report))
    restamp(dir)

    expect(audit(permuted).status).toBe(0)
    expect(digestOf(permuted)).toBe(digestOf(truthful))
  })
})

describe('7.3 — mode downgrade only', () => {
  it('is detected even though the failures are truthful', () => {
    const root = matrix()
    edit(mutantDir(root), 'scoring.json', (scoring) => {
      scoring['attribution_mode'] = 'owning_test'
    })
    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('attribution_derivation_disagrees')
  })

  it('changes the semantic digest', () => {
    const truthful = matrix()
    const downgraded = matrix()
    edit(mutantDir(downgraded), 'scoring.json', (scoring) => {
      scoring['attribution_mode'] = 'owning_test'
    })
    expect(digestOf(downgraded)).not.toBe(digestOf(truthful))
  })
})

describe('7.4 — mode downgrade plus a missing identity', () => {
  /** The reviewer's exact reproduction: downgrade, drop a failure, rebind. */
  function downgradeAndDrop(root: string): void {
    const dir = mutantDir(root)
    edit(dir, 'scoring.json', (scoring) => {
      scoring['attribution_mode'] = 'owning_test'
      scoring['observed_failed_test_identities'] = []
    })
    const report = JSON.parse(readFileSync(resolve(dir, 'vitest-report.json'), 'utf8')) as {
      testResults: Array<{ assertionResults: Array<{ fullName: string; status: string }> }>
    }
    for (const suite of report.testResults) {
      for (const assertion of suite.assertionResults) {
        if (assertion.fullName === TEST_NAME) assertion.status = 'passed'
      }
    }
    writeFileSync(resolve(dir, 'vitest-report.json'), JSON.stringify(report))
    restamp(dir)
  }

  it('reports both the mode disagreement and the missing identity', () => {
    const root = matrix()
    downgradeAndDrop(root)
    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('attribution_derivation_disagrees')
    expect(result.codes).toContain('missing_expected_failed_test')
  })

  it('changes the semantic digest', () => {
    const truthful = matrix()
    const tampered = matrix()
    downgradeAndDrop(tampered)
    expect(digestOf(tampered)).not.toBe(digestOf(truthful))
  })
})

describe('7.5 — mode upgrade disagreement', () => {
  it('is detected when a one-owning-test mutant claims exact-set', () => {
    // The other direction: a declaration that says owning_test cannot be
    // dressed up as exact-set evidence either.
    const produced = produceEvidenceMatrix()
    try {
      const root = copyMatrix(produced.runRoot)
      copies.push(dirname(root))
      expect(readJson(mutantDir(root), 'meta.json')['attribution_mode']).toBe('owning_test')
      edit(mutantDir(root), 'scoring.json', (scoring) => {
        scoring['attribution_mode'] = 'exact_failure_set'
      })
      const child = spawnSync(process.execPath, [
        AUDITOR, root, '--expect-mutants', '1', '--expect-baselines', '1',
      ], { cwd: produced.project, encoding: 'utf8' })
      const output = `${child.stdout ?? ''}${child.stderr ?? ''}`
      expect(child.status).not.toBe(0)
      expect(output).toContain('attribution_derivation_disagrees')
    } finally {
      discardMatrix(produced.project)
    }
  }, 60_000)
})

describe('7.6 — missing or unknown stored mode', () => {
  it('rejects a missing stored mode', () => {
    const root = matrix()
    edit(mutantDir(root), 'scoring.json', (scoring) => {
      delete scoring['attribution_mode']
    })
    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('attribution_derivation_disagrees')
  })

  it('rejects an unknown stored mode', () => {
    const root = matrix()
    edit(mutantDir(root), 'scoring.json', (scoring) => {
      scoring['attribution_mode'] = 'whatever_mode'
    })
    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('attribution_derivation_disagrees')
  })

  it('rejects a missing declared mode', () => {
    // The authority itself going absent must fail closed, not fall back to a
    // permissive default.
    const root = matrix()
    edit(mutantDir(root), 'meta.json', (meta) => {
      delete meta['attribution_mode']
    })
    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('attribution_derivation_disagrees')
  })
})

describe('7.7 — nested and top-level disagreement', () => {
  it('is detected when only the top-level mode is changed', () => {
    const root = matrix()
    const before = readJson(mutantDir(root), 'scoring.json')
    expect((before['attribution'] as Record<string, unknown>)['mode']).toBe('exact_failure_set')
    edit(mutantDir(root), 'scoring.json', (scoring) => {
      scoring['attribution_mode'] = 'owning_test'
    })
    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('attribution_derivation_disagrees')
  })

  it('is detected when only the nested mode is changed', () => {
    const root = matrix()
    edit(mutantDir(root), 'scoring.json', (scoring) => {
      (scoring['attribution'] as Record<string, unknown>)['mode'] = 'owning_test'
    })
    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('attribution_derivation_disagrees')
  })
})

describe('7.8 — an actual identity change with truthful rebinding', () => {
  it('is detected and moves the digest, with the mode left truthful', () => {
    const truthful = matrix()
    const root = matrix()
    const dir = mutantDir(root)
    const report = JSON.parse(readFileSync(resolve(dir, 'vitest-report.json'), 'utf8')) as {
      testResults: Array<{ assertionResults: Array<{ fullName: string; status: string }> }>
    }
    for (const suite of report.testResults) {
      for (const assertion of suite.assertionResults) {
        if (assertion.fullName === TEST_NAME) assertion.status = 'passed'
      }
    }
    writeFileSync(resolve(dir, 'vitest-report.json'), JSON.stringify(report))
    edit(dir, 'scoring.json', (scoring) => {
      scoring['observed_failed_test_identities'] = []
    })
    restamp(dir)

    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('missing_expected_failed_test')
    expect(digestOf(root)).not.toBe(digestOf(truthful))
  })
})

describe('7.3b — the nested attribution representation is required', () => {
  /** The nested result object the scorer persists beside its verdict. */
  const nested = (dir: string): Record<string, unknown> =>
    readJson(dir, 'scoring.json')['attribution'] as Record<string, unknown>

  it('is present and carries its mode in truthful evidence', () => {
    const dir = mutantDir(matrix())
    expect(nested(dir)['mode']).toBe('exact_failure_set')
    for (const field of ['declared', 'actual', 'unexpected', 'missing']) {
      expect(Array.isArray(nested(dir)[field]), field).toBe(true)
    }
  })

  it('7.3 detects a deleted nested mode and moves the digest', () => {
    // The reviewer's reproduction: everything else truthful, only the nested
    // mode removed. Absence was silence, because the mode was validated only
    // when present.
    const truthful = matrix()
    const root = matrix()
    edit(mutantDir(root), 'scoring.json', (scoring) => {
      delete (scoring['attribution'] as Record<string, unknown>)['mode']
    })
    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('attribution_derivation_disagrees')
    expect(digestOf(root)).not.toBe(digestOf(truthful))
  })

  it('7.4 detects a deleted nested attribution object and moves the digest', () => {
    const truthful = matrix()
    const root = matrix()
    edit(mutantDir(root), 'scoring.json', (scoring) => {
      delete scoring['attribution']
    })
    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('attribution_derivation_disagrees')
    expect(digestOf(root)).not.toBe(digestOf(truthful))
  })

  it('7.7 detects a deleted nested mode alongside a missing identity', () => {
    const truthful = matrix()
    const root = matrix()
    const dir = mutantDir(root)
    edit(dir, 'scoring.json', (scoring) => {
      delete (scoring['attribution'] as Record<string, unknown>)['mode']
      scoring['observed_failed_test_identities'] = []
    })
    const report = JSON.parse(readFileSync(resolve(dir, 'vitest-report.json'), 'utf8')) as {
      testResults: Array<{ assertionResults: Array<{ fullName: string; status: string }> }>
    }
    for (const suite of report.testResults) {
      for (const assertion of suite.assertionResults) {
        if (assertion.fullName === TEST_NAME) assertion.status = 'passed'
      }
    }
    writeFileSync(resolve(dir, 'vitest-report.json'), JSON.stringify(report))
    restamp(dir)

    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('attribution_derivation_disagrees')
    expect(result.codes).toContain('missing_expected_failed_test')
    expect(digestOf(root)).not.toBe(digestOf(truthful))
  })
})

describe('7.8 — every persisted nested field is compared, not just equal', () => {
  /**
   * The scorer writes seven pieces of nested material. Comparing only `equal`
   * left the other six written and never read, so the recorded identity list
   * could be emptied while the boolean beside it still claimed agreement.
   */
  const cases = [
    ['actual emptied', (n: Record<string, unknown>) => { n['actual'] = [] }],
    ['declared emptied', (n: Record<string, unknown>) => { n['declared'] = [] }],
    ['unexpected invented', (n: Record<string, unknown>) => { n['unexpected'] = ['something'] }],
    ['missing invented', (n: Record<string, unknown>) => { n['missing'] = ['something'] }],
    ['duplicateActual invented', (n: Record<string, unknown>) => { n['duplicateActual'] = ['dup'] }],
    ['duplicateDeclared invented', (n: Record<string, unknown>) => { n['duplicateDeclared'] = ['dup'] }],
    ['equal falsified', (n: Record<string, unknown>) => { n['equal'] = false }],
    ['actual replaced by a non-array', (n: Record<string, unknown>) => { n['actual'] = 'twenty five' }],
  ] as const

  for (const [label, corrupt] of cases) {
    it(`detects ${label}`, () => {
      const root = matrix()
      edit(mutantDir(root), 'scoring.json', (scoring) => {
        corrupt(scoring['attribution'] as Record<string, unknown>)
      })
      const result = audit(root)
      expect(result.status).not.toBe(0)
      expect(result.codes).toContain('attribution_derivation_disagrees')
    })
  }

  it('moves the digest for every corruption', () => {
    const truthful = digestOf(matrix())
    for (const [, corrupt] of cases) {
      const root = matrix()
      edit(mutantDir(root), 'scoring.json', (scoring) => {
        corrupt(scoring['attribution'] as Record<string, unknown>)
      })
      expect(digestOf(root)).not.toBe(truthful)
    }
  })
})

describe('7.9 — stored scorer result corruption is still detected', () => {
  it('rejects a falsified stored equality', () => {
    const root = matrix()
    edit(mutantDir(root), 'scoring.json', (scoring) => {
      (scoring['attribution'] as Record<string, unknown>)['equal'] = false
    })
    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('attribution_derivation_disagrees')
  })

  it('rejects a falsified classification', () => {
    const root = matrix()
    edit(mutantDir(root), 'scoring.json', (scoring) => {
      scoring['classification'] = 'uncaught'
    })
    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('classification_unsupported')
  })
})
