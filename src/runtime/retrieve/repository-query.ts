import { realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'

import type { KnowledgeGraph } from '../../contracts/graph.js'
import { readPackageManifest } from '../../shared/package-manifest.js'
import { scanPromptRegions } from '../../shared/prompt-regions.js'
import { extractPromptExclusions, retrievalSubjectPrompt } from '../retrieval-gate.js'
import { compileSourceExclusions } from '../source-exclusions.js'

/** Request-local evidence interpretation, never a public prompt or cache field. */
export const repositoryQueryKey = Symbol('repositoryQuery')
export interface RepositoryQueryBinding {
  readonly rawQuestion: string
  readonly effectiveQuestion: string
  readonly root: string
}
interface PackageProof { path: string; text: string; rootIdentity: string; fileIdentity: string }
const issued = new WeakMap<RepositoryQueryBinding, PackageProof>()

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
  // Keep the existing leading "In NAME source, ..." parser unchanged. These
  // two additional prose forms require an indexed, current repository name.
  const frames = [...rawQuestion.matchAll(/\bin[ \t]+([A-Za-z][A-Za-z0-9-]{0,79})(?=[ \t]*,)/gi)]
  const leading = /^[ \t]*How[ \t]+does[ \t]+([A-Za-z][A-Za-z0-9-]{0,79})[ \t]+(?=[a-z][a-z-]*\b)/.exec(rawQuestion)
  if (leading) frames.push(leading)
  if (frames.length !== 1) return undefined
  const frame = frames[0]!, name = frame[1]!
  const offset = frame.index! + frame[0].lastIndexOf(name), end = offset + name.length
  if (!/[a-z0-9][A-Z]/.test(name)
    || scanPromptRegions(rawQuestion).some(region => region.start < end && region.end > frame.index!)
    || /["`\u2018\u2019\u201c\u201d]/.test(rawQuestion)
    || /(?:^|[^\p{L}\p{N}_$])'|'(?:$|[^\p{L}\p{N}_$])/u.test(rawQuestion)) return undefined
  // A separately requested occurrence, including a code call/member/path,
  // retains the ordinary literal interpretation for the entire question.
  const occurrences = [...rawQuestion.matchAll(/[A-Za-z_$][A-Za-z0-9_$-]*/g)]
    .filter(match => match[0].toLowerCase() === name.toLowerCase())
  if (occurrences.length !== 1 || occurrences[0]!.index !== offset
    || !extractPromptExclusions(rawQuestion).positivePrompt.includes(name)) return undefined
  const packagePath = resolve(root, 'package.json')
  let indexed = false
  for (const [, node] of graph.nodeEntries()) {
    const file = typeof node.source_file === 'string' ? node.source_file : ''
    if (file && resolve(root, file) === packagePath) indexed = true
    const label = typeof node.label === 'string' ? node.label : ''
    if (node.file_type === 'code' && node.external_call !== true && label !== basename(file)
      && label.replace(/\(\)$/, '').split(/[.:]/).at(-1)?.toLowerCase() === name.toLowerCase()) return undefined
  }
  if (!indexed) return undefined
  const proof = allowedPackage(root, rawQuestion)
  if (!proof) return undefined
  const manifest: unknown = JSON.parse(proof.text)
  const packageName = (manifest as { name?: unknown }).name
  // No aliases, suffix matching or display-name inference. Scoped or punctuated
  // package names do not match a different bare project spelling.
  if (typeof packageName !== 'string' || packageName.length > 214
    || !/^[a-z0-9][a-z0-9._-]*$/.test(packageName) || packageName !== name.toLowerCase()) return undefined
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
