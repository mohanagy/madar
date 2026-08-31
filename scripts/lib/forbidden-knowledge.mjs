/**
 * #660-B -- production independence from qualification-repository knowledge.
 *
 * Madar's retrieval and claim behaviour must follow generic structural
 * evidence. A name, path or code shape lifted from a qualification target that
 * reaches production means behaviour was shaped around that repository instead
 * of around evidence, and a benchmark result produced that way measures the
 * tuning rather than the tool.
 *
 * This module owns the LITERAL and NORMALIZED half of that guarantee. It
 * parses every production source file with the TypeScript compiler and
 * inspects the places repository knowledge can actually be written down:
 *
 *   - string literals, no-substitution templates, and every fixed span of a
 *     template expression (preferred-file arrays, score-table keys, paths)
 *   - regular-expression literals (the form most contaminated rules used)
 *   - identifiers and property names (symbols, preferred-symbol lists)
 *   - comments (a target named in prose is still that knowledge in production)
 *
 * It deliberately does NOT claim to detect all semantic overfitting. A rule
 * keyed on prompt vocabulary, a forced selection, or a reserved result slot
 * encodes the qualification task without containing any name in the manifest.
 * That class is owned by direct behavioural tests, and pretending a text
 * scanner covers it would be the more dangerous error.
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { productionSourceFiles } from './grader-boundary.mjs'

export const FORBIDDEN_KNOWLEDGE_IN_PRODUCTION = 'FORBIDDEN_QUALIFICATION_KNOWLEDGE_IN_PRODUCTION'
export const FORBIDDEN_KNOWLEDGE_MANIFEST_INVALID = 'FORBIDDEN_KNOWLEDGE_MANIFEST_INVALID'

const MANIFEST_PATH = 'scripts/lib/forbidden-knowledge-manifest.json'
const CORPUS_PATH = 'docs/qualification/corpus.json'

/* ------------------------------------------------------------------ *
 * Normalization
 * ------------------------------------------------------------------ */

/**
 * Whole-token form. Splits camel/Pascal humps, turns every run of
 * non-alphanumerics into one space, lowercases, and pads with spaces so a
 * needle matches as a contiguous run of WHOLE tokens rather than as a bare
 * substring. `statusPage`, `status_page`, `status-page`, `status.page` and
 * `status/page` all reduce to the same thing.
 */
export function tokenForm(value) {
  const spaced = String(value)
    .replaceAll('\\', '/')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  return spaced.length === 0 ? '' : ` ${spaced} `
}

/**
 * Case-flattened form. Removes every separator, so `generateScoringLedger` and
 * the `generatescoringledger` spelling a lowercasing rule actually uses reduce
 * to one string. Without this the manifest would miss the encoding in which
 * most of the removed demotion tables were written.
 */
export function squashForm(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function matchForms(haystack, needle) {
  const forms = []
  const needleTokens = tokenForm(needle)
  if (needleTokens.length > 0 && tokenForm(haystack).includes(needleTokens)) {
    forms.push('tokens')
  }
  const needleSquashed = squashForm(needle)
  if (needleSquashed.length > 0 && squashForm(haystack).includes(needleSquashed)) {
    forms.push('squashed')
  }
  return forms
}

/* ------------------------------------------------------------------ *
 * Manifest
 * ------------------------------------------------------------------ */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const RULE_CLASSES = new Set(['path', 'symbol', 'phrase'])
const MINIMUM_DISTINCTIVE_LENGTH = 4

/**
 * Fail-closed manifest validation. A guard whose configuration is not itself
 * checked can be switched off by a typo, so a malformed manifest is a failure
 * of the check, never a warning beside a green result.
 */
export function loadForbiddenKnowledgeManifest(root = process.cwd(), options = {}) {
  const problems = []
  const manifestPath = resolve(root, MANIFEST_PATH)
  if (!existsSync(manifestPath)) {
    return { ok: false, problems: [`manifest missing at ${MANIFEST_PATH}`], rules: [], exceptions: [] }
  }

  let raw
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return { ok: false, problems: [`manifest is not valid JSON: ${error.message}`], rules: [], exceptions: [] }
  }

  if (typeof raw.manifest_version !== 'string' || raw.manifest_version.trim().length === 0) {
    problems.push('manifest_version must be a non-empty string')
  }

  const rules = []
  const seenIds = new Set()
  const seenNormalized = new Map()

  if (!Array.isArray(raw.rules) || raw.rules.length === 0) {
    problems.push('rules must be a non-empty array')
  } else {
    for (const [index, entry] of raw.rules.entries()) {
      const where = `rules[${index}]`
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        problems.push(`${where} must be an object`)
        continue
      }

      const { id, repository, class: ruleClass, value, why } = entry
      let malformed = false
      for (const [field, fieldValue] of Object.entries({ id, repository, value, why })) {
        if (typeof fieldValue !== 'string' || fieldValue.trim().length === 0) {
          problems.push(`${where}.${field} must be a non-empty string`)
          malformed = true
        }
      }
      if (!RULE_CLASSES.has(ruleClass)) {
        problems.push(`${where}.class must be one of ${[...RULE_CLASSES].join(', ')}`)
        malformed = true
      }
      if (malformed) {
        continue
      }

      if (seenIds.has(id)) {
        problems.push(`${where}.id duplicates an earlier rule id: ${id}`)
        continue
      }
      seenIds.add(id)

      // Two rules that normalize identically can never both fire, so the
      // second is dead configuration that makes the manifest look broader
      // than the protection it actually provides.
      const normalizedKey = `${squashForm(value)}${tokenForm(value)}`
      if (seenNormalized.has(normalizedKey)) {
        problems.push(`${where} (${id}) normalizes identically to ${seenNormalized.get(normalizedKey)}; remove the duplicate`)
        continue
      }
      seenNormalized.set(normalizedKey, id)

      if (squashForm(value).length < MINIMUM_DISTINCTIVE_LENGTH) {
        problems.push(`${where} (${id}) value ${JSON.stringify(value)} is too short to be distinctive; a rule this broad would fire on ordinary code`)
        continue
      }

      rules.push({ id, repository, class: ruleClass, value, why, origin: MANIFEST_PATH })
    }
  }

  // The frozen contract already names the distinctive symbols of the pinned
  // targets. Importing them keeps this manifest in step with the contract
  // instead of drifting from it. The contract file is read, never written.
  const importSpec = raw.corpus_symbol_import
  if (importSpec !== undefined) {
    if (importSpec === null || typeof importSpec !== 'object' || Array.isArray(importSpec)) {
      problems.push('corpus_symbol_import must be an object when present')
    } else {
      const corpusRelative = importSpec.source ?? CORPUS_PATH
      const corpusPath = resolve(root, corpusRelative)
      if (!existsSync(corpusPath)) {
        problems.push(`corpus_symbol_import.source missing at ${corpusRelative}`)
      } else {
        try {
          const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'))
          const pointer = importSpec.pointer ?? 'forbidden_target_symbols'
          const groups = corpus[pointer]
          let imported = 0
          if (groups !== null && typeof groups === 'object' && !Array.isArray(groups)) {
            for (const [target, symbols] of Object.entries(groups)) {
              if (!Array.isArray(symbols)) {
                continue
              }
              for (const symbol of symbols) {
                if (typeof symbol !== 'string' || squashForm(symbol).length < MINIMUM_DISTINCTIVE_LENGTH) {
                  continue
                }
                const normalizedKey = `${squashForm(symbol)}${tokenForm(symbol)}`
                if (seenNormalized.has(normalizedKey)) {
                  continue
                }
                seenNormalized.set(normalizedKey, `corpus/${target}/${symbol}`)
                rules.push({
                  id: `corpus/${target}/${symbol}`,
                  repository: target,
                  class: 'symbol',
                  value: symbol,
                  why: `Declared distinctive symbol of pinned qualification target "${target}" in the frozen contract.`,
                  origin: corpusRelative,
                })
                imported += 1
              }
            }
          }
          if (imported === 0) {
            problems.push(`corpus_symbol_import matched no symbols at ${corpusRelative}#${pointer}; the pointer or the contract shape changed`)
          }
        } catch (error) {
          problems.push(`corpus_symbol_import unreadable: ${error.message}`)
        }
      }
    }
  }

  const exceptions = []
  const ruleIds = new Set(rules.map((rule) => rule.id))
  const rawExceptions = raw.exceptions ?? []
  if (!Array.isArray(rawExceptions)) {
    problems.push('exceptions must be an array')
  } else {
    const seenExceptionIds = new Set()
    const today = options.today ?? new Date().toISOString().slice(0, 10)
    for (const [index, entry] of rawExceptions.entries()) {
      const where = `exceptions[${index}]`
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        problems.push(`${where} must be an object`)
        continue
      }

      const { id, rule_id: ruleId, file, why, expires } = entry
      let malformed = false
      for (const [field, fieldValue] of Object.entries({ id, rule_id: ruleId, file, why, expires })) {
        if (typeof fieldValue !== 'string' || fieldValue.trim().length === 0) {
          problems.push(`${where}.${field} must be a non-empty string`)
          malformed = true
        }
      }
      if (malformed) {
        continue
      }

      if (seenExceptionIds.has(id)) {
        problems.push(`${where}.id duplicates an earlier exception id: ${id}`)
        continue
      }
      seenExceptionIds.add(id)

      if (!ruleIds.has(ruleId)) {
        problems.push(`${where}.rule_id ${JSON.stringify(ruleId)} matches no rule`)
        continue
      }

      // A wildcard exception is an exemption with no boundary: it keeps
      // approving files nobody reviewed. One exception, one exact file.
      if (/[*?[\]]/.test(file) || file.includes('..')) {
        problems.push(`${where}.file must be one exact repo-relative path, not a pattern: ${file}`)
        continue
      }

      if (!ISO_DATE.test(expires)) {
        problems.push(`${where}.expires must be an ISO date (YYYY-MM-DD): ${expires}`)
        continue
      }
      if (expires < today) {
        problems.push(`${where} (${id}) expired on ${expires}; renew it with a reason or delete it`)
        continue
      }

      exceptions.push({ id, ruleId, file, why, expires })
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    rules,
    exceptions,
    manifestVersion: raw.manifest_version,
  }
}

/* ------------------------------------------------------------------ *
 * Scanning
 * ------------------------------------------------------------------ */

/**
 * Every place a name, path or shape can be written down in a source file, with
 * the line it sits on. Literals and regexes carry the encoded forms;
 * identifiers carry symbol references; comments carry prose knowledge.
 */
export function knowledgeBearingSites(sourceText, fileName = 'file.ts') {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const sites = []
  const seen = new Set()

  const record = (kind, text, position) => {
    if (typeof text !== 'string' || text.trim().length === 0) {
      return
    }
    const line = source.getLineAndCharacterOfPosition(position).line + 1
    const key = `${kind}${line}${text}`
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    sites.push({ kind, text, line })
  }

  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      record('string', node.text, node.getStart(source))
    } else if (ts.isRegularExpressionLiteral(node)) {
      record('regex', node.text, node.getStart(source))
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      // Fixed spans of a template: the interpolations vary, the spans do not.
      record('template', node.text, node.getStart(source))
    } else if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      record('identifier', node.text, node.getStart(source))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)

  // Comments are not reachable from forEachChild, and a qualification target
  // named in prose is still that knowledge sitting in production.
  for (const match of sourceText.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g)) {
    record('comment', match[0], match.index)
  }

  return sites
}

function isExcepted(exceptions, ruleId, file) {
  return exceptions.some((exception) => exception.ruleId === ruleId && exception.file === file)
}

export function analyzeForbiddenKnowledge(input = {}) {
  const root = input.root ?? process.cwd()
  const manifest = input.manifest ?? loadForbiddenKnowledgeManifest(root, input)

  if (!manifest.ok) {
    return {
      ok: false,
      reason: FORBIDDEN_KNOWLEDGE_MANIFEST_INVALID,
      manifestProblems: manifest.problems,
      manifestVersion: manifest.manifestVersion ?? null,
      violations: [],
      filesScanned: 0,
      rulesApplied: 0,
      unusedExceptions: [],
    }
  }

  const files = input.files ?? productionSourceFiles(root)
  const readFile = input.readFile ?? ((file) => readFileSync(resolve(root, file), 'utf8'))
  const violations = []
  const usedExceptions = new Set()

  for (const file of files) {
    const text = readFile(file)

    // Cheap pre-filter: if neither normalized form of the whole file contains a
    // rule value, no site inside it can either. Keeps the AST walk off the
    // files that have nothing to find.
    const fileTokens = tokenForm(text)
    const fileSquashed = squashForm(text)
    const candidateRules = manifest.rules.filter((rule) => (
      fileTokens.includes(tokenForm(rule.value)) || fileSquashed.includes(squashForm(rule.value))
    ))
    if (candidateRules.length === 0) {
      continue
    }

    for (const site of knowledgeBearingSites(text, file)) {
      for (const rule of candidateRules) {
        const forms = matchForms(site.text, rule.value)
        if (forms.length === 0) {
          continue
        }
        if (isExcepted(manifest.exceptions, rule.id, file)) {
          usedExceptions.add(`${rule.id}${file}`)
          continue
        }
        violations.push({
          file,
          line: site.line,
          site: site.kind,
          rule: rule.id,
          repository: rule.repository,
          ruleClass: rule.class,
          ruleValue: rule.value,
          why: rule.why,
          raw: site.text.length > 200 ? `${site.text.slice(0, 200)}...` : site.text,
          normalized: forms.includes('tokens') ? tokenForm(site.text).trim() : squashForm(site.text),
          matchForms: forms,
        })
      }
    }
  }

  // A stale exception is worse than none: it silently keeps approving a rule
  // that no longer fires, and hides the day that rule starts firing again.
  const unusedExceptions = manifest.exceptions.filter(
    (exception) => !usedExceptions.has(`${exception.ruleId}${exception.file}`),
  )

  violations.sort((left, right) => (
    left.file.localeCompare(right.file)
    || left.line - right.line
    || left.rule.localeCompare(right.rule)
    || left.site.localeCompare(right.site)
  ))

  return {
    ok: violations.length === 0 && unusedExceptions.length === 0,
    reason: violations.length > 0 ? FORBIDDEN_KNOWLEDGE_IN_PRODUCTION : null,
    manifestProblems: [],
    manifestVersion: manifest.manifestVersion,
    violations,
    filesScanned: files.length,
    rulesApplied: manifest.rules.length,
    unusedExceptions,
  }
}

export function formatForbiddenKnowledgeReport(result) {
  const lines = []

  if (result.reason === FORBIDDEN_KNOWLEDGE_MANIFEST_INVALID) {
    lines.push(`${FORBIDDEN_KNOWLEDGE_MANIFEST_INVALID}: the manifest is not usable, so the scan proves nothing.`)
    for (const entry of result.manifestProblems) {
      lines.push(`  - ${entry}`)
    }
    return lines.join('\n')
  }

  lines.push(
    `Production independence scan: ${result.filesScanned} production files, `
    + `${result.rulesApplied} manifest rules (manifest ${result.manifestVersion}).`,
  )

  if (result.violations.length > 0) {
    lines.push('')
    lines.push(`${FORBIDDEN_KNOWLEDGE_IN_PRODUCTION}: ${result.violations.length} occurrence(s).`)
    for (const violation of result.violations) {
      lines.push(`  ${violation.file}:${violation.line}  [${violation.rule}]`)
      lines.push(`    site       ${violation.site}, matched via ${violation.matchForms.join('+')}`)
      lines.push(`    rule       ${violation.ruleClass} ${JSON.stringify(violation.ruleValue)} (${violation.repository}) -- ${violation.why}`)
      lines.push(`    raw        ${violation.raw}`)
      lines.push(`    normalized ${violation.normalized}`)
    }
  }

  if (result.unusedExceptions.length > 0) {
    lines.push('')
    lines.push(`${result.unusedExceptions.length} exception(s) matched nothing and must be deleted:`)
    for (const exception of result.unusedExceptions) {
      lines.push(`  - ${exception.id} (rule ${exception.ruleId}, file ${exception.file})`)
    }
  }

  if (result.ok) {
    lines.push('')
    lines.push('No qualification-repository knowledge found in production source.')
    lines.push('NOTE: this scan owns literal and normalized contamination only. Task-phrase')
    lines.push('ranking and forced-selection contamination are owned by behavioural tests.')
  }

  return lines.join('\n')
}
