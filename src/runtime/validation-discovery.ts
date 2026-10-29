import * as fs from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import type { ImplementationPackValidationDiscovery } from '../contracts/context-pack.js'
import { sensitiveArtifactReason } from '../shared/discovery-safety.js'
import { isDiscoveryPathIgnored } from '../shared/source-discovery.js'

const MAX_PACKAGE_BYTES = 128 * 1024
const MAX_POLICY_BYTES = 64 * 1024
const MAX_POLICY_PATTERNS = 1024
const VALIDATION_SCRIPTS = new Set(['typecheck', 'build', 'test:run', 'test'])
type Status = Exclude<ImplementationPackValidationDiscovery['status'], 'inspected'>
type ReadResult = { status: 'read'; text: string; path: string } | { status: Status }

function withinRoot(path: string, root: string): boolean {
  const local = relative(root, path)
  return local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)
}

function excluded(path: string, root: string, paths: readonly string[]): boolean {
  return paths.some(value => value.trim().length > 0 && withinRoot(path, resolve(root, value)))
}

function readBounded(path: string, root: string, maxBytes: number, denied: readonly string[], patterns: readonly string[] = []): ReadResult {
  let descriptor: number | undefined
  let pathObserved = false
  try {
    if (!withinRoot(path, root) || excluded(path, root, denied) || isDiscoveryPathIgnored(path, root, patterns)
      || sensitiveArtifactReason(path, root, { isSourceFile: false })) return { status: 'blocked' }
    fs.lstatSync(path)
    pathObserved = true
    const actual = fs.realpathSync(path)
    if (!withinRoot(actual, root) || excluded(actual, root, denied) || isDiscoveryPathIgnored(actual, root, patterns)
      || sensitiveArtifactReason(actual, root, { isSourceFile: false })) return { status: 'blocked' }
    const before = fs.statSync(actual)
    if (!before.isFile()) return { status: 'blocked' }
    if (before.size > maxBytes) return { status: 'bounded' }
    // Do not block on devices/FIFOs or follow a last-component replacement.
    descriptor = fs.openSync(actual, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    const opened = fs.fstatSync(descriptor)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || fs.realpathSync(path) !== actual) return { status: 'blocked' }
    if (opened.size > maxBytes) return { status: 'bounded' }
    const buffer = Buffer.alloc(maxBytes + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const count = fs.readSync(descriptor, buffer, bytes, buffer.length - bytes, null)
      if (count === 0) break
      bytes += count
    }
    if (bytes > maxBytes) return { status: 'bounded' }
    const after = fs.fstatSync(descriptor)
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) return { status: 'unreadable' }
    try {
      return { status: 'read', text: new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes)), path: actual }
    } catch {
      return { status: 'invalid_json' }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { status: code === 'ENOENT' && !pathObserved ? 'missing' : code === 'ELOOP' ? 'blocked' : 'unreadable' }
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch { /* Descriptor cleanup must not turn an inspection into an exception. */ }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Inspect only root package validation scripts; never execute commands or infer repository-wide test absence. */
export function inspectRootPackageValidation(
  rootPath?: string,
  options: { excludedPaths?: readonly string[] } = {},
): { scripts: Record<string, string>; discovery: ImplementationPackValidationDiscovery; warnings: string[] } {
  const base = { source_file: 'package.json' as const, scope: 'root_package_validation_scripts' as const, observed_at: new Date().toISOString() }
  const failed = (status: Status, warning: string) => ({ scripts: {}, discovery: { ...base, status }, warnings: [warning] })
  if (!rootPath?.trim()) return failed('unknown_root', 'No workspace root was recorded, so validation commands could not inspect package.json.')
  let root: string
  try {
    root = fs.realpathSync(resolve(rootPath))
    if (!fs.statSync(root).isDirectory()) return failed('unknown_root', 'The workspace root is not a directory, so package.json was not inspected.')
  } catch (error) {
    return failed((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unknown_root' : 'unreadable', 'The workspace root could not be read to inspect package.json.')
  }
  const logicalRoot = resolve(rootPath)
  const denied = (options.excludedPaths ?? []).filter(path => path.trim().length > 0).map(path => {
    const absolute = resolve(logicalRoot, path)
    return withinRoot(absolute, logicalRoot) ? resolve(root, relative(logicalRoot, absolute)) : absolute
  })
  const packagePath = resolve(root, 'package.json')
  if (excluded(packagePath, root, denied)) return failed('blocked', 'Package validation inspection was excluded by source policy.')
  const policy = readBounded(resolve(root, '.madarignore'), root, MAX_POLICY_BYTES, [])
  let patterns: string[] = []
  if (policy.status === 'read') {
    patterns = policy.text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0 && !line.startsWith('#'))
    if (patterns.length > MAX_POLICY_PATTERNS) return failed('bounded', 'Package validation inspection exceeded the ignore-policy limit.')
  } else if (policy.status !== 'missing') {
    return failed(policy.status === 'bounded' ? 'bounded' : 'blocked', 'Package validation inspection could not establish the root ignore policy.')
  }
  if (isDiscoveryPathIgnored(packagePath, root, patterns)) return failed('blocked', 'Package validation inspection was excluded by source policy.')
  const contents = readBounded(packagePath, root, MAX_PACKAGE_BYTES, denied, patterns)
  if (contents.status !== 'read') {
    if (contents.status === 'missing') return failed('missing', 'No package.json was found in the analyzed workspace root.')
    if (contents.status === 'invalid_json') return failed('invalid_json', 'Could not parse the analyzed workspace package.json to derive validation commands.')
    return failed(contents.status, `Package validation inspection was ${contents.status}; script availability is unknown.`)
  }
  if (isDiscoveryPathIgnored(contents.path, root, patterns)) return failed('blocked', 'Package validation inspection was excluded by source policy.')
  let parsed: unknown
  try { parsed = JSON.parse(contents.text) } catch {
    return failed('invalid_json', 'Could not parse the analyzed workspace package.json to derive validation commands.')
  }
  if (!isRecord(parsed)) return failed('invalid_package', 'The analyzed workspace package.json is not a JSON object.')
  if (!Object.hasOwn(parsed, 'scripts')) return { scripts: {}, discovery: { ...base, status: 'inspected', result: 'no_scripts' }, warnings: ['The analyzed workspace package.json does not define scripts for validation commands.'] }
  if (!isRecord(parsed.scripts) || Object.values(parsed.scripts).some(value => typeof value !== 'string')) {
    return failed('invalid_scripts', 'The analyzed workspace package.json has an invalid scripts object; validation commands were not derived.')
  }
  const entries = Object.entries(parsed.scripts) as Array<[string, string]>
  const scripts = Object.fromEntries(entries.filter(([, value]) => value.trim().length > 0))
  return { scripts, discovery: { ...base, status: 'inspected', result: entries.length === 0 ? 'no_scripts'
    : Object.keys(scripts).some(name => VALIDATION_SCRIPTS.has(name)) ? 'commands_available' : 'no_supported_validation_scripts' }, warnings: [] }
}
