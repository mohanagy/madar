import * as fs from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { sensitiveArtifactReason } from './discovery-safety.js'
import { isDiscoveryPathIgnored } from './source-discovery.js'

const MAX_POLICY_BYTES = 64 * 1024
const MAX_POLICY_PATTERNS = 1024
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const withinRoot = (path: string, root: string): boolean => {
  const local = relative(root, path)
  return local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)
}

/** Bounded descriptor read, including canonical-path and identity checks before and after reading. */
export function readBoundedSource(path: string, root: string, realRoot: string, maxBytes: number, isSource: boolean, preserveBOM = false): { text: string; canonical: string; hash: string; bytes: number } {
  if (!withinRoot(path, root) || sensitiveArtifactReason(path, root, { isSourceFile: isSource })) throw new Error('Source continuation path is not permitted')
  let descriptor: number | undefined
  try {
    const canonical = fs.realpathSync(path)
    if (!withinRoot(canonical, realRoot) || sensitiveArtifactReason(canonical, realRoot, { isSourceFile: isSource })) throw new Error('Source continuation canonical path is not permitted')
    const before = fs.statSync(canonical)
    if (!before.isFile() || before.size > maxBytes) throw new Error('Source continuation file exceeds its read bound')
    descriptor = fs.openSync(canonical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    const opened = fs.fstatSync(descriptor)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maxBytes
      || fs.realpathSync(path) !== canonical || fs.realpathSync(root) !== realRoot) throw new Error('Source continuation file identity changed')
    const buffer = Buffer.alloc(maxBytes + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const count = fs.readSync(descriptor, buffer, bytes, buffer.length - bytes, null)
      if (!count) break
      bytes += count
    }
    const after = fs.fstatSync(descriptor)
    const current = fs.statSync(canonical)
    if (bytes > maxBytes || bytes !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs || current.dev !== opened.dev || current.ino !== opened.ino
      || fs.realpathSync(path) !== canonical || fs.realpathSync(root) !== realRoot) throw new Error('Source continuation file changed while reading')
    const content = buffer.subarray(0, bytes)
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: preserveBOM }).decode(content)
    if (text.includes('\0')) throw new Error('Source continuation file is not plain source text')
    return { text, canonical, hash: digest(content), bytes: content.length }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}
export function readSourceIgnorePolicy(root: string, realRoot: string): { patterns: string[]; fingerprint: string; bytes: number } {
  const path = resolve(root, '.madarignore')
  try { fs.lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { patterns: [], fingerprint: 'missing', bytes: 0 }
    throw new Error('Source continuation ignore policy cannot be inspected')
  }
  const policy = readBoundedSource(path, root, realRoot, MAX_POLICY_BYTES, false)
  const patterns = policy.text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
  if (patterns.length > MAX_POLICY_PATTERNS) throw new Error('Source continuation ignore policy exceeds its bound')
  return { patterns, fingerprint: digest(`${policy.canonical}\0${policy.hash}`), bytes: policy.bytes }
}

/** Current policy, not graph membership, authorizes both logical and canonical source paths.
 * No source content is read here; callers retain their existing content/size contracts.
 */
export function sourcePathsAllowedByCurrentPolicy(sourceFiles: readonly string[], rootPath: string): boolean {
  if (!sourceFiles.length) return true
  if (sourceFiles.length > 1024) return false
  try {
    const root = resolve(rootPath), realRoot = fs.realpathSync(root)
    const policy = readSourceIgnorePolicy(root, realRoot)
    const identities: Array<[string, string]> = []
    for (const sourceFile of new Set(sourceFiles)) {
      if (!sourceFile || sourceFile.includes('\0')) return false
      const logical = resolve(root, sourceFile)
      if (!withinRoot(logical, root)) return false
      const canonical = fs.realpathSync(logical)
      if (!withinRoot(canonical, realRoot)
        || isDiscoveryPathIgnored(logical, root, policy.patterns)
        || isDiscoveryPathIgnored(canonical, realRoot, policy.patterns)) return false
      identities.push([logical, canonical])
    }
    return identities.every(([logical, canonical]) => fs.realpathSync(logical) === canonical)
      && fs.realpathSync(root) === realRoot
      && readSourceIgnorePolicy(root, realRoot).fingerprint === policy.fingerprint
  } catch { return false }
}
