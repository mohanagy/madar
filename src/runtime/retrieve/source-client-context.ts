import ts from 'typescript'
import { retrievalEvidencePrompt } from '../retrieval-gate.js'
import { sourceBodyQueryTerms, sourceBodyWords, sourceRequestProse } from './source-evidence.js'

export interface SourceClientImportGroup { specifier: string; names: string[] }

/** An authored scope preference, never an inference from a framework label. */
export function sourceClientContextRequest(question: string): boolean {
  if (question.length > 12_000) return false
  const prose = sourceRequestProse(retrievalEvidencePrompt(question))
  const scope = prose.match(/(?:^|[.!?;]\s*)focus\s+(?:on\s+)?(?:the\s+)?(?:client|browser)[-\s]+side\b([^.!?;]*)/i)
  return !!scope && !/\b(?:if|when|unless|provided|depending)\b/i.test(scope[1]!)
    && !/\b(?:servers?|backend|callers?|consumers?|dependents?|impact|affected|breaks?)\b/i.test(prose)
}

export function sourceHasDirective(source: ts.SourceFile, directive: string): boolean {
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break
    if (statement.expression.text === directive) return true
  }
  return false
}

/** Current import spellings are bounded navigation hints only. The checker must
 * subsequently prove every chosen binding and call before source is reserved. */
export function sourceClientImportGroup(source: ts.SourceFile, question: string): SourceClientImportGroup | undefined {
  if (!sourceClientContextRequest(question) || !sourceHasDirective(source, 'use client')
    || sourceHasDirective(source, 'use server') || source.statements.length > 512
    || (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) return undefined
  const terms = new Set(sourceBodyQueryTerms(retrievalEvidencePrompt(question)))
  const groups = new Map<string, string[]>(), unsupported = new Set<string>()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const specifier = statement.moduleSpecifier.text, clause = statement.importClause
    const bindings = clause?.namedBindings
    if (!clause || clause.isTypeOnly || !bindings || !ts.isNamedImports(bindings)
      || bindings.elements.some(binding => binding.propertyName || binding.isTypeOnly)) {
      unsupported.add(specifier); continue
    }
    if (groups.has(specifier)) { unsupported.add(specifier); continue }
    groups.set(specifier, bindings.elements.map(binding => binding.name.text)
      .filter(name => sourceBodyWords(name).some(word => terms.has(word))))
  }
  const qualifying: SourceClientImportGroup[] = []
  for (const [specifier, names] of groups) {
    if (unsupported.has(specifier) || names.length < 2 || names.length > 4 || new Set(names).size !== names.length) continue
    const matches = names.map(name => new Set(sourceBodyWords(name).filter(word => terms.has(word))))
    const all = new Set(matches.flatMap(words => [...words]))
    if (all.size >= 2 && [...matches[0]!].some(word => matches.every(words => words.has(word)))) qualifying.push({ specifier, names })
  }
  return qualifying.length === 1 ? qualifying[0] : undefined
}
