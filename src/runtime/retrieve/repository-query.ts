import { realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'

import type { KnowledgeGraph } from '../../contracts/graph.js'
import { readPackageManifest } from '../../shared/package-manifest.js'
import { scanPromptRegions } from '../../shared/prompt-regions.js'
import { extractPromptExclusions, retrievalSubjectPrompt } from '../retrieval-gate.js'
import { compileSourceExclusions } from '../source-exclusions.js'
import { sourceQueryLiterals } from './source-evidence.js'

/** Request-local evidence interpretation, never a public prompt or cache field. */
export const repositoryQueryKey = Symbol('repositoryQuery')
export interface RepositoryQueryBinding {
  readonly rawQuestion: string
  readonly effectiveQuestion: string
  readonly root: string
}
interface PackageProof { path: string; text: string; rootIdentity: string; fileIdentity: string }
const issued = new WeakMap<RepositoryQueryBinding, PackageProof>()

/** Code syntax and authored lookup roles outrank repository identity, not casing. */
function namesSourceOccurrence(question: string, start: number, end: number): boolean {
  const before = question.slice(0, start), after = question.slice(end)
  const regions: Array<{ start: number; end: number }> = scanPromptRegions(question)
  for (const [open, close] of [['\u201c', '\u201d'], ['\u2018', '\u2019']] as const) {
    for (let index = question.indexOf(open); index >= 0;) {
      const last = question.indexOf(close, index + 1)
      if (last < 0) break
      regions.push({ start: index, end: last + 1 })
      index = question.indexOf(open, last + 1)
    }
  }
  if (regions.some(region => region.start < end && region.end > start)
    || /["'`\u2018\u2019\u201c\u201d]/.test(question[start - 1] ?? '')
    || /["'`\u2018\u2019\u201c\u201d]/.test(question[end] ?? '')
    || /(?:[./\\#$@]|::)[ \t]*$/.test(before)
    || /^[ \t]*(?:\(|\[|[/\\]|::|\?\.|\.[ \t]*[#A-Za-z_$])/.test(after)) return true
  // Use the literal lookup's existing prefix vocabulary for this occurrence,
  // not another literal earlier in the request. Quoted data cannot start a clause.
  let clauseStart = 0
  for (const boundary of before.matchAll(/[.!?;,:\r\n]|\b(?:and|then|also)\b/gi)) {
    if (!regions.some(region => region.start <= boundary.index && region.end > boundary.index)) {
      clauseStart = boundary.index + boundary[0].length
    }
  }
  const prefix = before.slice(clauseStart).trim()
  if (/^(?:please\s+)?(?:where\s+(?:is|are|can\s+I\s+find)|(?:find|locate|show)(?:\s+me)?)(?:\s+(?:the|a|an|error|literal|string|identifier|symbol|function|method|definition|source|code|occurrences|locations|references|for|containing|of))*$/i.test(prefix)) return true
  const roles = 'functions?|methods?|class(?:es)?|symbols?|identifiers?|literals?|strings?|constants?|variables?|types?|interfaces?|enums?|propert(?:y|ies)|fields?|modules?|namespaces?|constructors?|declarations?|definitions?|implementations?|source|code'
  if (new RegExp(`\\b(?:${roles})(?:[ \\t]+(?:named|called|of|for|the|a|an))*[ \\t]+$`, 'i').test(before)
    || new RegExp(`^[ \\t]+(?:${roles})\\b`, 'i').test(after)) return true
  return /^(?:please[ \t]+)?(?:explain|describe|trace|inspect|analyze)(?:[ \t]+the)?$/i.test(prefix)
    && /^[.!? \t]*$/.test(after)
}

function allowedPackage(root: string, question: string): PackageProof | undefined {
  const exclusions = extractPromptExclusions(question)
  if (exclusions.excludedDomains.includes('config')
    || exclusions.excludedTerms.some(term => /^config(?:uration)?(?:\s+files?)?$/i.test(term))) return undefined
  const policy = compileSourceExclusions(exclusions.excludedTerms, exclusions.excludedPathHints, root)
  const path = resolve(root, 'package.json')
  if (!policy.valid || policy.matchesSource(path, 'package.json', root)) return undefined
  try {
    const canonicalRoot = realpathSync(root), canonical = realpathSync(path)
    if (canonical !== resolve(canonicalRoot, 'package.json')
      || policy.matchesSource(canonical, 'package.json', canonicalRoot)) return undefined
    const manifest = readPackageManifest(path, root)
    if (!manifest || manifest.path !== canonical) return undefined
    const rootStat = statSync(canonicalRoot), fileStat = statSync(canonical)
    return { path: manifest.path, text: manifest.text,
      rootIdentity: `${canonicalRoot}\0${rootStat.dev}\0${rootStat.ino}`,
      fileIdentity: `${canonical}\0${fileStat.dev}\0${fileStat.ino}` }
  } catch { return undefined }
}

/** A known repository may frame behavior without naming a code occurrence. */
export function prepareRepositoryQuery(
  graph: KnowledgeGraph, rawQuestion: string, taskKind: string,
): RepositoryQueryBinding | undefined {
  const rootValue = graph.graph.root_path
  if (taskKind !== 'explain' || rawQuestion.length > 16_384
    || typeof rootValue !== 'string' || !isAbsolute(rootValue)) return undefined
  const root = resolve(rootValue)
  // Already-lexical leading repository locators need no package read. For
  // other prose, identity determines framing independently of sentence form.
  const literals = new Set(sourceQueryLiterals(rawQuestion))
  const occurrences = [...rawQuestion.matchAll(/[A-Za-z_$][A-Za-z0-9_$-]*/g)]
  const candidates = occurrences.filter(match => /^[A-Za-z][A-Za-z0-9-]{0,79}$/.test(match[0])
    && /[a-z0-9][A-Z]/.test(match[0]) && literals.has(match[0]))
  if (!candidates.length) return undefined
  const names = new Set(candidates.map(match => match[0].toLowerCase()))
  const declared = new Set<string>()
  const packagePath = resolve(root, 'package.json')
  let indexed = false
  for (const [, node] of graph.nodeEntries()) {
    const file = typeof node.source_file === 'string' ? node.source_file : ''
    if (file && resolve(root, file) === packagePath) indexed = true
    const label = typeof node.label === 'string' ? node.label : ''
    const name = label.replace(/\(\)$/, '').split(/[.:]/).at(-1)?.toLowerCase()
    if (node.file_type === 'code' && node.external_call !== true && label !== basename(file)
      && name && names.has(name)) declared.add(name)
  }
  if (!indexed) return undefined
  const proof = allowedPackage(root, rawQuestion)
  if (!proof) return undefined
  const manifest: unknown = JSON.parse(proof.text)
  const packageName = (manifest as { name?: unknown }).name
  // No aliases, suffix matching or display-name inference. Scoped or punctuated
  // package names do not match a different bare project spelling.
  if (typeof packageName !== 'string' || packageName.length > 214
    || !/^[a-z0-9][a-z0-9._-]*$/.test(packageName) || declared.has(packageName)) return undefined
  const matching = occurrences.filter(match => match[0].toLowerCase() === packageName)
  if (matching.length !== 1 || !candidates.includes(matching[0]!)) return undefined
  const occurrence = matching[0]!, name = occurrence[0], offset = occurrence.index, end = offset + name.length
  if (!extractPromptExclusions(rawQuestion).positivePrompt.includes(name)
    || namesSourceOccurrence(rawQuestion, offset, end)) return undefined
  const split = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  const effectiveQuestion = retrievalSubjectPrompt(rawQuestion.slice(0, offset) + split + rawQuestion.slice(end))
  const binding = Object.freeze({ rawQuestion, effectiveQuestion, root })
  issued.set(binding, proof)
  return binding
}

/** Stale, forged, cross-root or reworded copies retain the original policy. */
export function repositoryEvidenceQuestion(
  result: { question: string; task_contract?: { task_kind?: string; prompt?: string }; [repositoryQueryKey]?: RepositoryQueryBinding }, root: string,
): string {
  const binding = result[repositoryQueryKey], previous = binding && issued.get(binding)
  if (!binding || !previous || result.question !== binding.rawQuestion || resolve(root) !== binding.root
    || result.task_contract?.task_kind !== 'explain' || result.task_contract.prompt !== binding.effectiveQuestion) return result.question
  const current = allowedPackage(binding.root, binding.rawQuestion)
  return current && current.path === previous.path && current.text === previous.text
    && current.rootIdentity === previous.rootIdentity && current.fileIdentity === previous.fileIdentity
    ? binding.effectiveQuestion : result.question
}
