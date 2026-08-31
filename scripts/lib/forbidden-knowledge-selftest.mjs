/**
 * #660-B falsifiability harness for the production independence scan.
 *
 * A scan that has never been shown to fail is decorative. These controls put
 * real qualification-repository knowledge back into a real production file, in
 * each of the encodings the manifest claims to normalize, and require the
 * scanner to reject it naming the exact file, line and rule. Then they put the
 * bytes back and prove they went back.
 *
 * Each control declares a PREMISE -- the observable fact the injection was
 * supposed to create -- checked before the verdict is read. Without it a
 * silently no-op injection is indistinguishable from a working control, which
 * is the failure mode that makes a guard look green while proving nothing.
 *
 * Restoration is by byte snapshot, never by `git checkout`/`reset`/`clean`:
 * the worktree may carry other uncommitted work, and a git-based "restore"
 * would destroy it. Every restore is digest-verified, and a file that cannot
 * be restored is reported loudly.
 *
 * Runs standalone (never inside the vitest worker pool) because it mutates
 * source files on disk.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { ByteSnapshot } from './grader-boundary-selftest.mjs'
import {
  analyzeForbiddenKnowledge,
  loadForbiddenKnowledgeManifest,
  FORBIDDEN_KNOWLEDGE_IN_PRODUCTION,
  FORBIDDEN_KNOWLEDGE_MANIFEST_INVALID,
} from './forbidden-knowledge.mjs'

const MANIFEST = 'scripts/lib/forbidden-knowledge-manifest.json'

// A production file that is decontaminated and stays in scope, so an injection
// here is a true reintroduction rather than a change to an unscanned file.
const TARGET = 'src/runtime/retrieve.ts'

/** The scanner reported at least one violation at this file for this rule. */
const expectViolation = (file, ruleId) => (result) => (
  (result.violations ?? []).some((violation) => (
    violation.file === file
    && violation.rule === ruleId
    && Number.isInteger(violation.line)
    && violation.line > 0
    && typeof violation.raw === 'string'
    && violation.raw.length > 0
    && typeof violation.normalized === 'string'
    && violation.normalized.length > 0
  ))
)

/** The scanner refused the manifest itself rather than scanning the tree. */
const expectManifestProblem = (fragment) => (result) => (
  result.reason === FORBIDDEN_KNOWLEDGE_MANIFEST_INVALID
  && (result.manifestProblems ?? []).some((problem) => problem.includes(fragment))
)

function injectionCases() {
  return [
    {
      id: 'F1',
      title: 'exact forbidden repository path reintroduced as a string literal',
      expectRule: 'openstatus/path-router-status-page',
      verdict: expectViolation(TARGET, 'openstatus/path-router-status-page'),
      inject(snapshot) {
        snapshot.append(TARGET, [
          '',
          '// #660-B F1 injection',
          "const F1_PREFERRED_FILES = ['packages/api/src/router/statusPage.ts']",
          'void F1_PREFERRED_FILES',
          '',
        ].join('\n'))
      },
    },
    {
      id: 'F2',
      title: 'forbidden symbol reintroduced in a normalized (snake_case) spelling',
      expectRule: 'openstatus/symbol-http-checker-handler',
      verdict: expectViolation(TARGET, 'openstatus/symbol-http-checker-handler'),
      inject(snapshot) {
        // Deliberately NOT the original spelling. If the scanner only matched
        // the literal it was given, this passes unnoticed.
        snapshot.append(TARGET, [
          '',
          '// #660-B F2 injection',
          "const F2_ROLE = 'http_checker_handler'",
          'void F2_ROLE',
          '',
        ].join('\n'))
      },
    },
    {
      id: 'F3',
      title: 'forbidden symbol reintroduced in a case-flattened score table',
      expectRule: 'report-generation/symbol-generate-scoring-ledger',
      verdict: expectViolation(TARGET, 'report-generation/symbol-generate-scoring-ledger'),
      inject(snapshot) {
        // The encoding the removed demotion table actually used: all lowercase,
        // no separators, inside a regex alternation.
        snapshot.append(TARGET, [
          '',
          '// #660-B F3 injection',
          'const F3_DEMOTIONS = /(?:generatescoringledger|somethingelse)/i',
          'void F3_DEMOTIONS',
          '',
        ].join('\n'))
      },
    },
    {
      id: 'F4',
      title: 'forbidden path fragment reintroduced inside a template span',
      expectRule: 'openstatus/path-status-page-utils',
      verdict: expectViolation(TARGET, 'openstatus/path-status-page-utils'),
      inject(snapshot) {
        snapshot.append(TARGET, [
          '',
          '// #660-B F4 injection',
          'const F4_SUFFIX = `${String(1)}/statusPage.utils.ts`',
          'void F4_SUFFIX',
          '',
        ].join('\n'))
      },
    },
    {
      id: 'F12',
      title: 'a hex-escaped string literal is decoded before matching',
      expectRule: 'openstatus/symbol-status-page',
      verdict: expectViolation(TARGET, 'openstatus/symbol-status-page'),
      inject(snapshot) {
        snapshot.append(TARGET, [
          '',
          '// #660-B F12 injection',
          "const F12_NAME = '\\x73tatusPage'",
          'void F12_NAME',
          '',
        ].join('\n'))
      },
    },
    {
      id: 'F13',
      title: 'a hex-escaped regex literal is decoded before matching',
      expectRule: 'openstatus/symbol-status-page',
      verdict: expectViolation(TARGET, 'openstatus/symbol-status-page'),
      inject(snapshot) {
        snapshot.append(TARGET, [
          '',
          '// #660-B F13 injection',
          'const F13_PATTERN = /status\\x50age/i',
          'void F13_PATTERN',
          '',
        ].join('\n'))
      },
    },
    {
      id: 'F14',
      title: 'a name split across a static concatenation is folded before matching',
      expectRule: 'openstatus/symbol-status-page',
      verdict: expectViolation(TARGET, 'openstatus/symbol-status-page'),
      inject(snapshot) {
        snapshot.append(TARGET, [
          '',
          '// #660-B F14 injection',
          "const F14_NAME = 'status' + 'Page'",
          'void F14_NAME',
          '',
        ].join('\n'))
      },
    },
    {
      id: 'F15',
      title: 'a name split across a static template is folded before matching',
      expectRule: 'openstatus/symbol-status-page',
      verdict: expectViolation(TARGET, 'openstatus/symbol-status-page'),
      inject(snapshot) {
        snapshot.append(TARGET, [
          '',
          '// #660-B F15 injection',
          'const F15_NAME = `status${\'\'}Page`',
          'void F15_NAME',
          '',
        ].join('\n'))
      },
    },
    {
      id: 'F16',
      title: 'a unicode-escaped string literal is decoded before matching',
      expectRule: 'openstatus/symbol-status-page',
      verdict: expectViolation(TARGET, 'openstatus/symbol-status-page'),
      inject(snapshot) {
        snapshot.append(TARGET, [
          '',
          '// #660-B F16 injection',
          "const F16_NAME = '\\u0073tatusPage'",
          'void F16_NAME',
          '',
        ].join('\n'))
      },
    },
    {
      id: 'F19',
      title: 'a legacy octal regex escape is decoded before matching',
      expectRule: 'openstatus/symbol-status-page',
      verdict: expectViolation(TARGET, 'openstatus/symbol-status-page'),
      inject(snapshot) {
        // /\\163tatusPage/ executes as /statusPage/. A scanner that reads the
        // raw spelling sees nothing forbidden at all.
        snapshot.append(TARGET, [
          '',
          '// #660-B1 F19 injection',
          'const F19_PATTERN = /\\163tatusPage/i',
          'void F19_PATTERN',
          '',
        ].join('\n'))
      },
    },
    {
      id: 'F20',
      title: 'a preferred-file list entry written as a static concatenation is folded',
      expectRule: 'openstatus/path-router-status-page',
      verdict: expectViolation(TARGET, 'openstatus/path-router-status-page'),
      inject(snapshot) {
        snapshot.append(TARGET, [
          '',
          '// #660-B1 F20 injection',
          "const F20_PREFERRED = ['packages/api/src/router/' + 'statusPage.ts']",
          'void F20_PREFERRED',
          '',
        ].join('\n'))
      },
    },
    {
      id: 'F5',
      title: 'forbidden symbol reintroduced as an identifier, not a string',
      expectRule: 'openstatus/symbol-page-indicator',
      verdict: expectViolation(TARGET, 'openstatus/symbol-page-indicator'),
      inject(snapshot) {
        snapshot.append(TARGET, [
          '',
          '// #660-B F5 injection',
          'const pageIndicator = (value: string): string => value',
          'void pageIndicator',
          '',
        ].join('\n'))
      },
    },
  ]
}

function manifestCases() {
  const base = () => JSON.parse(readFileSync(resolve(process.cwd(), MANIFEST), 'utf8'))
  return [
    {
      id: 'F6',
      title: 'a malformed rule is refused rather than skipped',
      verdict: expectManifestProblem('must be a non-empty string'),
      mutate(manifest) {
        manifest.rules.push({ id: 'broken/rule', repository: 'x', class: 'symbol', value: '', why: 'malformed on purpose' })
        return manifest
      },
    },
    {
      id: 'F7',
      title: 'a duplicate rule id is refused',
      verdict: expectManifestProblem('duplicates an earlier rule id'),
      mutate(manifest) {
        manifest.rules.push({ ...manifest.rules[0] })
        return manifest
      },
    },
    {
      id: 'F8',
      title: 'a wildcard exception is refused',
      verdict: expectManifestProblem('must be one exact repo-relative path'),
      mutate(manifest) {
        manifest.exceptions = [{
          id: 'wildcard', rule_id: manifest.rules[0].id, file: 'src/**/*.ts',
          why: 'a boundary-less exemption', expires: '2099-01-01',
        }]
        return manifest
      },
    },
    {
      id: 'F9',
      title: 'an expired exception is refused',
      verdict: expectManifestProblem('expired on'),
      mutate(manifest) {
        manifest.exceptions = [{
          id: 'expired', rule_id: manifest.rules[0].id, file: TARGET,
          why: 'stale on purpose', expires: '2020-01-01',
        }]
        return manifest
      },
    },
    {
      id: 'F17',
      title: 'an impossible calendar date is refused, not merely shape-checked',
      verdict: expectManifestProblem('must be a real ISO calendar date'),
      mutate(manifest) {
        manifest.exceptions = [{
          id: 'impossible-date', rule_id: manifest.rules[0].id, file: TARGET,
          why: 'shaped like a date but is not one', expires: '2099-13-45',
        }]
        return manifest
      },
    },
    {
      id: 'F18',
      title: 'two exemptions covering the same rule and file are refused',
      verdict: expectManifestProblem('one exemption per rule per file'),
      mutate(manifest) {
        manifest.exceptions = [
          { id: 'first', rule_id: manifest.rules[0].id, file: TARGET, why: 'first', expires: '2099-01-01' },
          { id: 'second', rule_id: manifest.rules[0].id, file: TARGET, why: 'duplicate scope', expires: '2099-01-01' },
        ]
        return manifest
      },
    },
    {
      id: 'F10',
      title: 'an exception that matches nothing is reported as unused',
      verdict: (result) => (result.unusedExceptions ?? []).some((entry) => entry.id === 'unused') && result.ok === false,
      mutate(manifest) {
        manifest.exceptions = [{
          id: 'unused', rule_id: manifest.rules[0].id, file: TARGET,
          why: 'matches nothing because the tree is clean', expires: '2099-01-01',
        }]
        return manifest
      },
    },
  ]
  void base
}

export function runForbiddenKnowledgeSelfTest({ root = process.cwd(), log = console.log } = {}) {
  const results = []

  // Read the untouched tree first, so a dirty baseline is reported as such
  // rather than as a failed injection.
  const baseline = analyzeForbiddenKnowledge({ root })
  results.push({
    id: 'F0',
    title: 'the untouched tree is clean, so every injection below starts from zero',
    passed: baseline.ok === true && baseline.violations.length === 0 && baseline.rulesApplied > 0,
    detail: baseline.ok
      ? `clean; ${baseline.filesScanned} file(s), ${baseline.rulesApplied} rule(s)`
      : `baseline is NOT clean: ${baseline.violations.map((v) => `${v.file}:${v.line} [${v.rule}]`).join(', ')}`,
  })

  for (const testCase of injectionCases()) {
    const snapshot = new ByteSnapshot(root)
    let passed = false
    let detail = ''
    try {
      testCase.inject(snapshot)

      // PREMISE: the injected text is really on disk. Without this a no-op
      // injection would look exactly like a working control.
      const injected = readFileSync(resolve(root, TARGET), 'utf8')
      const premiseHolds = injected.includes(`${testCase.id} injection`)
      if (!premiseHolds) {
        detail = 'injection did not reach the file; the control proves nothing'
      } else {
        const result = analyzeForbiddenKnowledge({ root })
        passed = result.ok === false
          && result.reason === FORBIDDEN_KNOWLEDGE_IN_PRODUCTION
          && testCase.verdict(result)
        const hit = (result.violations ?? []).find((v) => v.rule === testCase.expectRule)
        detail = passed
          ? `rejected at ${hit.file}:${hit.line} via ${hit.matchForms.join('+')}; raw ${JSON.stringify(hit.raw.trim())}`
          : `expected rule ${testCase.expectRule} to fire; got ${
            (result.violations ?? []).map((v) => `${v.file}:${v.line} [${v.rule}]`).join(', ') || 'no violations'}`
      }
    } catch (error) {
      detail = `control threw: ${error?.message ?? String(error)}`
    } finally {
      const unrestored = snapshot.restore()
      if (unrestored.length > 0) {
        passed = false
        detail += ` | RESTORE FAILED: ${unrestored.join(', ')}`
      }
    }
    results.push({ id: testCase.id, title: testCase.title, passed, detail })
  }

  for (const testCase of manifestCases()) {
    const snapshot = new ByteSnapshot(root)
    let passed = false
    let detail = ''
    try {
      const mutated = testCase.mutate(JSON.parse(readFileSync(resolve(root, MANIFEST), 'utf8')))
      snapshot.write(MANIFEST, `${JSON.stringify(mutated, null, 2)}\n`)

      // PREMISE: the manifest on disk really changed.
      const onDisk = JSON.parse(readFileSync(resolve(root, MANIFEST), 'utf8'))
      const premiseHolds = JSON.stringify(onDisk) === JSON.stringify(mutated)
      if (!premiseHolds) {
        detail = 'manifest mutation did not reach disk; the control proves nothing'
      } else {
        const result = analyzeForbiddenKnowledge({ root })
        passed = result.ok === false && testCase.verdict(result)
        detail = passed
          ? `refused: ${(result.manifestProblems ?? []).concat(
            (result.unusedExceptions ?? []).map((e) => `unused exception ${e.id}`),
          ).join(' | ')}`
          : `expected a refusal; got ok=${result.ok} reason=${result.reason} problems=${
            JSON.stringify(result.manifestProblems ?? [])}`
      }
    } catch (error) {
      detail = `control threw: ${error?.message ?? String(error)}`
    } finally {
      const unrestored = snapshot.restore()
      if (unrestored.length > 0) {
        passed = false
        detail += ` | RESTORE FAILED: ${unrestored.join(', ')}`
      }
    }
    results.push({ id: testCase.id, title: testCase.title, passed, detail })
  }

  // The tree must be exactly as clean afterwards as it was before, or a later
  // run inherits a mystery.
  const afterAll = analyzeForbiddenKnowledge({ root })
  const manifestAfter = loadForbiddenKnowledgeManifest(root)
  results.push({
    id: 'F11',
    title: 'the tree and the manifest are restored exactly',
    passed: afterAll.ok === true
      && afterAll.violations.length === 0
      && manifestAfter.ok === true
      && manifestAfter.rules.length === (baseline.rulesApplied ?? 0),
    detail: afterAll.ok && manifestAfter.ok
      ? `clean; ${manifestAfter.rules.length} rule(s) restored`
      : `NOT restored: ${afterAll.violations.map((v) => `${v.file}:${v.line}`).join(', ')} ${manifestAfter.problems.join(' | ')}`,
  })

  for (const entry of results) {
    log(`  ${entry.passed ? 'PASS' : 'FAIL'}  ${entry.id}  ${entry.title}`)
    log(`        ${entry.detail}`)
  }

  return { ok: results.every((entry) => entry.passed), results }
}
