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

/**
 * Decode the escape forms a name can hide behind in regex source. TypeScript
 * already decodes escapes inside string literals for us; regex source arrives
 * raw, so \x50 and P have to be resolved here or /status\x50age/i reads as
 * innocent text. A stray backslash before an ordinary word character is dropped
 * for the same reason.
 */
export function decodeEscapes(value) {
  return String(value)
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex) => safeFromCodePoint(hex, 16))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => safeFromCodePoint(hex, 16))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => safeFromCodePoint(hex, 16))
    // Legacy ECMAScript octal escapes, which are still executable inside a
    // regex: /\163tatusPage/ runs as /statusPage/. Decoded BEFORE the generic
    // stray-backslash rule below, which would otherwise turn \163 into 163 and
    // destroy the evidence.
    .replace(/\\([0-7]{1,3})/g, (whole, digits) => decodeLegacyOctal(whole, digits))
    .replace(/\\([A-Za-z0-9])/g, '$1')
}

function safeFromCodePoint(digits, radix) {
  const code = Number.parseInt(digits, radix)
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
}

/**
 * `\NNN` is ambiguous in a regex: it is a BACKREFERENCE when capture groups
 * exist and a legacy octal escape otherwise, and a static scanner cannot always
 * tell. The split used here is the one that matters for hiding a name: only
 * escapes that decode to a PRINTABLE ASCII character are treated as octal.
 *
 * That resolves the ambiguity in the safe direction. `\163` decodes to `s` and
 * is treated as text; `\1`..`\9` decode to control characters, are left alone,
 * and continue to read as backreferences. Anything outside printable ASCII is
 * returned unchanged rather than silently deleted, so an unsupported spelling
 * stays visible in the decoded value instead of being called clean.
 */
function decodeLegacyOctal(whole, digits) {
  const code = Number.parseInt(digits, 8)
  if (!Number.isInteger(code) || code < 0x20 || code > 0x7e) {
    return whole
  }
  return String.fromCodePoint(code)
}

/**
 * Both normalized forms of one value, computed ONCE.
 *
 * The forms used to be recomputed for every (site, rule) pair, which made the
 * scan cost sites x rules string transformations: measured at 8.7s for 36
 * rules and 4.4s for 18, i.e. linear in the rule count, which is what tripped
 * the protected 15s control. Precomputing on both sides makes matching a plain
 * substring test and the rule count stops driving the cost.
 */
function normalizedForms(value) {
  const decoded = decodeEscapes(value)
  return { decoded, tokens: tokenForm(decoded), squashed: squashForm(decoded) }
}

/** Which precomputed forms of a site contain the precomputed forms of a rule. */
function matchPrecomputedForms(site, rule) {
  const forms = []
  if (rule.tokens.length > 0 && site.tokens.includes(rule.tokens)) {
    forms.push('tokens')
  }
  if (rule.squashed.length > 0 && site.squashed.includes(rule.squashed)) {
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

/** `2099-13-45` matches the shape but is not a date. Reject it as malformed. */
function isRealCalendarDate(value) {
  const [year, month, day] = value.split('-').map(Number)
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false
  }
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
}

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
    const seenExceptionScopes = new Map()
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

      if (!ISO_DATE.test(expires) || !isRealCalendarDate(expires)) {
        problems.push(`${where}.expires must be a real ISO calendar date (YYYY-MM-DD): ${expires}`)
        continue
      }
      if (expires < today) {
        problems.push(`${where} (${id}) expired on ${expires}; renew it with a reason or delete it`)
        continue
      }

      const scope = `${ruleId}\u0000${file}`
      if (seenExceptionScopes.has(scope)) {
        problems.push(`${where} (${id}) covers the same rule and file as ${seenExceptionScopes.get(scope)}; one exemption per rule per file`)
        continue
      }
      seenExceptionScopes.set(scope, id)

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

  /**
   * The string a statically foldable expression evaluates to, or null.
   *
   * `'status' + 'Page'` and `` `status${''}Page` `` are the same name as the
   * plain spelling, split across nodes that individually match nothing. Folding
   * them is what stops "write it in two pieces" from being a way through.
   * Only fully static expressions fold; anything computed at runtime returns
   * null and is left to the behavioural controls.
   */
  const staticValue = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return node.text
    }
    if (ts.isParenthesizedExpression(node)) {
      return staticValue(node.expression)
    }
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression?.(node)) {
      return staticValue(node.expression)
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = staticValue(node.left)
      const right = staticValue(node.right)
      return left === null || right === null ? null : left + right
    }
    if (ts.isTemplateExpression(node)) {
      let folded = node.head.text
      for (const span of node.templateSpans) {
        const inner = staticValue(span.expression)
        if (inner === null) {
          return null
        }
        folded += inner + span.literal.text
      }
      return folded
    }
    return null
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

    // Fold whole static expressions too, so a name split across several nodes
    // is matched as the one string it actually denotes.
    if (ts.isBinaryExpression(node) || ts.isTemplateExpression(node)) {
      const folded = staticValue(node)
      if (folded !== null) {
        record('folded', folded, node.getStart(source))
      }
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

/**
 * Read, decode, parse and normalize every production file exactly ONCE.
 *
 * The index is the scanner's only view of the tree; rules are applied to it
 * afterwards, so adding a rule costs one substring test per site rather than
 * another pass over the sources. `stats` is not decoration: the controls read
 * it to prove each file was parsed exactly once and that the parse count does
 * not move when the rule count does.
 */
export function buildProductionSourceIndex({ files, readFile }) {
  const byFile = new Map()
  const stats = { indexedFiles: 0, parseCalls: 0, siteCount: 0 }

  for (const file of files) {
    if (byFile.has(file)) {
      // A duplicate entry in the file list must not become a second parse.
      continue
    }
    const text = readFile(file)
    stats.parseCalls += 1
    const sites = knowledgeBearingSites(text, file).map((site) => ({
      ...site,
      ...normalizedForms(site.text),
    }))
    byFile.set(file, sites)
    stats.indexedFiles += 1
    stats.siteCount += sites.length
  }

  return { byFile, stats }
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
      stats: { indexedFiles: 0, parseCalls: 0, siteCount: 0 },
    }
  }

  const files = input.files ?? productionSourceFiles(root)
  const readFile = input.readFile ?? ((file) => readFileSync(resolve(root, file), 'utf8'))

  // Every file is read, decoded, parsed and normalized exactly once, BEFORE any
  // rule is consulted. There is deliberately no raw-text pre-filter: it would
  // read the file before escapes are decoded and before split literals are
  // folded, so an escaped or split name would skip the AST walk entirely and
  // the scan would report clean.
  const index = input.index ?? buildProductionSourceIndex({ files, readFile })

  // Rule needles are normalized once as well, not once per site.
  const rules = manifest.rules.map((rule) => ({ ...rule, ...normalizedForms(rule.value) }))

  const violations = []
  const usedExceptions = new Set()

  for (const [file, sites] of index.byFile) {
    for (const site of sites) {
      for (const rule of rules) {
        const forms = matchPrecomputedForms(site, rule)
        if (forms.length === 0) {
          continue
        }
        if (isExcepted(manifest.exceptions, rule.id, file)) {
          usedExceptions.add(`${rule.id}${file}`)
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
          decoded: site.decoded.length > 200 ? `${site.decoded.slice(0, 200)}...` : site.decoded,
          normalized: forms.includes('tokens') ? site.tokens.trim() : site.squashed,
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
    filesScanned: index.stats.indexedFiles,
    rulesApplied: rules.length,
    unusedExceptions,
    stats: index.stats,
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
