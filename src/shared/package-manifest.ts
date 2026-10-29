import * as fs from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { sensitiveArtifactReason } from './discovery-safety.js'
import { isDiscoveryPathIgnored } from './source-discovery.js'

export const MAX_PACKAGE_SOURCE_BYTES = 128 * 1024
const MAX_POLICY_BYTES = 64 * 1024
export const isPackageManifestPath = (path: string): boolean => basename(path) === 'package.json'
const within = (path: string, root: string): boolean => {
  const local = relative(root, path)
  return local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)
}

/** Configuration is never eligible for the ordinary source-name sensitive-path exemption. */
interface BoundedSource { path: string; text: string; bytes: number; device: number; inode: number }

function readBounded(path: string, root: string, realRoot: string, maxBytes: number): BoundedSource | null {
  let fd: number | undefined
  try {
    if (!within(path, root) || sensitiveArtifactReason(path, root, { isSourceFile: false })) return null
    let cursor = root
    for (const part of relative(root, path).split(sep)) {
      cursor = resolve(cursor, part)
      if (fs.lstatSync(cursor).isSymbolicLink()) return null
    }
    const actual = fs.realpathSync(path)
    if (!within(actual, realRoot) || sensitiveArtifactReason(actual, realRoot, { isSourceFile: false })) return null
    const before = fs.statSync(actual)
    if (!before.isFile() || before.size > maxBytes) return null
    fd = fs.openSync(actual, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    const opened = fs.fstatSync(fd)
    if (!opened.isFile() || opened.size > maxBytes || opened.dev !== before.dev || opened.ino !== before.ino || fs.realpathSync(path) !== actual) return null
    const buffer = Buffer.alloc(maxBytes + 1)
    let size = 0
    while (size < buffer.length) { const count = fs.readSync(fd, buffer, size, buffer.length - size, null); if (!count) break; size += count }
    const after = fs.fstatSync(fd), current = fs.statSync(actual)
    if (size > maxBytes || size !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || current.dev !== opened.dev || current.ino !== opened.ino || fs.realpathSync(path) !== actual || fs.realpathSync(root) !== realRoot) return null
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size))
    return text.includes('\0') ? null : { path: actual, text, bytes: size, device: opened.dev, inode: opened.ino }
  } catch { return null } finally { if (fd !== undefined) fs.closeSync(fd) }
}

/** Exact-name package source only; no arbitrary JSON, implicit expansion, or script execution. */
export function readPackageManifest(path: string, rootPath?: string): { path: string; text: string } | null {
  if (!isPackageManifestPath(path)) return null
  try {
    const logical = rootPath === undefined ? resolve(path) : resolve(rootPath, path)
    const root = resolve(rootPath ?? dirname(logical)), realRoot = fs.realpathSync(root)
    const policyPath = resolve(root, '.madarignore')
    let policy: { path: string; text: string } | null = null
    try { fs.lstatSync(policyPath); policy = readBounded(policyPath, root, realRoot, MAX_POLICY_BYTES); if (!policy) return null }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null }
    const patterns = (policy?.text ?? '').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
    if (patterns.length > 1024 || isDiscoveryPathIgnored(logical, root, patterns)) return null
    const source = readBounded(logical, root, realRoot, MAX_PACKAGE_SOURCE_BYTES)
    if (!source || !isPackageManifestPath(source.path) || isDiscoveryPathIgnored(source.path, realRoot, patterns)) return null
    const parsed: unknown = JSON.parse(source.text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (policy && readBounded(policyPath, root, realRoot, MAX_POLICY_BYTES)?.text !== policy.text) return null
    if (!policy) { try { fs.lstatSync(policyPath); return null } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null } }
    return source
  } catch { return null }
}


export const MAX_PACKAGE_SNAPSHOT_FILES = 32
export const MAX_PACKAGE_SNAPSHOT_BYTES = 1024 * 1024

/** Internal cache proof only: never contains manifest or policy source text. */
export interface PackageSourceSnapshot {
  version: 1
  root_path: string
  real_root: string | null
  root_identity: string | null
  policy: { status: 'missing' | 'valid' | 'unavailable'; identity?: string; sha256?: string }
  files: Array<{ path: string; status: 'valid' | 'unavailable'; canonical_path?: string; identity?: string; bytes?: number; sha256?: string }>
  cacheable: boolean
  bounded: boolean
}

const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
const sourceIdentity = (source: BoundedSource): string => `${source.path}\0${source.device}\0${source.inode}`

/** Reads only already indexed package paths; never discovers new files or follows descendant symlinks. */
export function capturePackageSourceSnapshot(paths: Iterable<string>, rootPath: string): PackageSourceSnapshot {
  const snapshot: PackageSourceSnapshot = {
    version: 1, root_path: resolve(rootPath), real_root: null, root_identity: null,
    policy: { status: 'unavailable' }, files: [], cacheable: false, bounded: false,
  }
  const indexedPaths = new Set<string>()
  for (const path of paths) {
    if (!isPackageManifestPath(path)) continue
    indexedPaths.add(resolve(snapshot.root_path, path))
    if (indexedPaths.size > MAX_PACKAGE_SNAPSHOT_FILES) { snapshot.bounded = true; return snapshot }
  }
  try {
    if (!isAbsolute(rootPath)) return snapshot
    const root = snapshot.root_path, realRoot = fs.realpathSync(root), rootStat = fs.statSync(realRoot)
    if (!rootStat.isDirectory()) return snapshot
    snapshot.real_root = realRoot
    snapshot.root_identity = `${realRoot}\0${rootStat.dev}\0${rootStat.ino}`
    const policyPath = resolve(root, '.madarignore')
    const readPolicy = (): BoundedSource | 'missing' | null => {
      try { fs.lstatSync(policyPath) } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : null }
      return readBounded(policyPath, root, realRoot, MAX_POLICY_BYTES)
    }
    const policy = readPolicy()
    if (policy === null) return snapshot
    snapshot.policy = policy === 'missing' ? { status: 'missing' }
      : { status: 'valid', identity: sourceIdentity(policy), sha256: digest(policy.text) }
    const patterns = (policy === 'missing' ? '' : policy.text).split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
    if (patterns.length > 1024) { snapshot.bounded = true; return snapshot }
    let remaining = MAX_PACKAGE_SNAPSHOT_BYTES
    for (const path of [...indexedPaths].sort()) {
      const entry: PackageSourceSnapshot['files'][number] = { path, status: 'unavailable' }
      snapshot.files.push(entry)
      if (!within(path, root) || isDiscoveryPathIgnored(path, root, patterns)) return snapshot
      if (remaining <= 0) { snapshot.bounded = true; return snapshot }
      const source = readBounded(path, root, realRoot, Math.min(MAX_PACKAGE_SOURCE_BYTES, remaining))
      if (!source) { if (remaining < MAX_PACKAGE_SOURCE_BYTES) snapshot.bounded = true; return snapshot }
      if (!isPackageManifestPath(source.path) || isDiscoveryPathIgnored(source.path, realRoot, patterns)) return snapshot
      remaining -= source.bytes
      const parsed: unknown = JSON.parse(source.text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return snapshot
      Object.assign(entry, { status: 'valid', canonical_path: source.path, identity: sourceIdentity(source), bytes: source.bytes, sha256: digest(source.text) })
    }
    const afterPolicy = readPolicy()
    if (policy === 'missing' ? afterPolicy !== 'missing' : afterPolicy === null || afterPolicy === 'missing'
      || sourceIdentity(afterPolicy) !== sourceIdentity(policy) || afterPolicy.text !== policy.text) return snapshot
    const afterRoot = fs.statSync(realRoot)
    if (fs.realpathSync(root) !== realRoot || afterRoot.dev !== rootStat.dev || afterRoot.ino !== rootStat.ino) return snapshot
    snapshot.cacheable = true
    return snapshot
  } catch { return snapshot }
}

/** Comparison is exact, including admitted path set, root, policy, canonical identities and original bytes. */
export function packageSourceSnapshotsMatch(previous: unknown, current: PackageSourceSnapshot | null): boolean {
  if (current === null) return previous === null
  if (!current.cacheable || current.bounded || !previous || typeof previous !== 'object') return false
  return JSON.stringify(previous) === JSON.stringify(current)
}
