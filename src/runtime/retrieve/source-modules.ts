import * as fs from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { sourceCompilerPath } from './source-compiler-host.js'

import { sensitiveArtifactReason } from '../../shared/discovery-safety.js'
import { isDiscoveryPathIgnored } from '../../shared/source-discovery.js'
import { EXTENSIONLESS_JS_TS_EXTENSIONS, JS_TS_EXTENSION_SUBSTITUTIONS } from '../../shared/source-extensions.js'
import { sourcePathForEvidence } from './source-evidence.js'

const MAX_CONFIG_FILES = 16
const MAX_CONFIG_DEPTH = 8
const MAX_CONFIG_BYTES = 256 * 1024
const MAX_POLICY_BYTES = 64 * 1024
const MAX_POLICY_PATTERNS = 1024
type ConfigRead = { status: 'read'; text: string } | { status: 'missing' | 'blocked' }
const configurationSnapshotKey = Symbol('sourceModuleConfigurationSnapshot')
export type SourceReadPolicy = (logicalPath: string, canonicalPath?: string) => boolean

export interface SourceModuleConfigurationSnapshot {
  version: 1
  root_path: string
  real_root: string
  files: Record<string, string>
  cacheable: boolean
}

export function getSourceModuleConfigurationSnapshot(receipt: unknown): SourceModuleConfigurationSnapshot | undefined {
  return receipt && typeof receipt === 'object'
    ? (receipt as { [configurationSnapshotKey]?: SourceModuleConfigurationSnapshot })[configurationSnapshotKey] : undefined
}

type SourceModuleResolver = ((specifier: string, importer: string) => string | undefined) & {
  matchesSnapshot: (snapshot: SourceModuleConfigurationSnapshot) => boolean
}

/** Revalidate cache metadata only within the expected request root. No module/source reads. */
export function sourceModuleConfigurationSnapshotIsFresh(snapshot: unknown, expectedRootPath: string | undefined, readPolicy?: SourceReadPolicy): boolean {
  if (!snapshot || typeof snapshot !== 'object' || !expectedRootPath) return false
  const value = snapshot as Partial<SourceModuleConfigurationSnapshot>
  if (value.version !== 1 || value.cacheable !== true || value.root_path !== resolve(expectedRootPath)
    || typeof value.real_root !== 'string' || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) return false
  const entries = Object.entries(value.files)
  if (!entries.length || entries.length > 256 || !Object.hasOwn(value.files, resolve(value.root_path, '.madarignore'))
    || entries.some(([path, fingerprint]) => !isAbsolute(path) || !withinRoot(path, value.root_path!)
      || typeof fingerprint !== 'string' || !/^(?:missing|sha256:[a-f0-9]{64})$/.test(fingerprint))) return false
  try { if (fs.realpathSync(expectedRootPath) !== value.real_root) return false } catch { return false }
  return createSourceModuleResolver(new Set(), expectedRootPath, () => {}, undefined, readPolicy).matchesSnapshot(value as SourceModuleConfigurationSnapshot)
}

function withinRoot(path: string, root: string): boolean {
  const local = relative(root, path)
  return local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)
}

/** Request-local only: changed configuration is never reused by a later retrieval. */
export function createSourceModuleResolver(
  indexed: ReadonlySet<string>, rootPath: string | undefined, incomplete: () => void, receipt?: object, readPolicy?: SourceReadPolicy,
): SourceModuleResolver {
  const logicalRoot = rootPath ? resolve(rootPath) : undefined
  let realRoot: string | undefined
  try { if (logicalRoot) realRoot = fs.realpathSync(logicalRoot) } catch { /* Alias resolution remains unavailable. */ }
  const configTexts = new Map<string, ConfigRead>()
  const optionsByDirectory = new Map<string, ts.CompilerOptions | null>()
  const resolutions = new Map<string, string | undefined>()
  const safeSources = new Map<string, string | null>()
  let configBytes = 0
  let configProbes = 0
  let patterns: string[] | undefined
  let policyBlocked = false
  let snapshot: SourceModuleConfigurationSnapshot | undefined
  const configurationSnapshot = (): SourceModuleConfigurationSnapshot => {
    if (!snapshot) {
      snapshot = { version: 1, root_path: logicalRoot ?? '', real_root: realRoot ?? '', files: {}, cacheable: true }
      // Enumerable symbols survive the retrieval receipt's object spread but
      // are deliberately absent from normal JSON/MCP serialization.
      if (receipt) Object.defineProperty(receipt, configurationSnapshotKey, { value: snapshot, enumerable: true })
    }
    return snapshot
  }
  const failInspection = (): void => { incomplete(); configurationSnapshot().cacheable = false }

  const readConfig = (path: string, policy = false): ConfigRead => {
    if (configTexts.has(path)) return configTexts.get(path)!
    configurationSnapshot()
    const blocked = (): ConfigRead => { failInspection(); return { status: 'blocked' } }
    if (++configProbes > 256 || readPolicy && !readPolicy(path)) return blocked()
    if (!logicalRoot || !realRoot || !withinRoot(path, logicalRoot)
      || (!policy && extname(path).toLowerCase() !== '.json')
      || sensitiveArtifactReason(path, logicalRoot, { isSourceFile: false })
      || isDiscoveryPathIgnored(path, logicalRoot, patterns ?? [])) return blocked()
    let descriptor: number | undefined
    let observed = false
    try {
      fs.lstatSync(path); observed = true
      const actual = fs.realpathSync(path)
      if (readPolicy && !readPolicy(path, actual)) return blocked()
      if (!withinRoot(actual, realRoot) || (!policy && extname(actual).toLowerCase() !== '.json')
        || sensitiveArtifactReason(actual, realRoot, { isSourceFile: false })
        || isDiscoveryPathIgnored(actual, realRoot, patterns ?? [])) return blocked()
      const maxBytes = policy ? MAX_POLICY_BYTES : MAX_CONFIG_BYTES - configBytes
      const before = fs.statSync(actual)
      if (!before.isFile() || before.size > maxBytes
        || (!policy && [...configTexts.values()].filter(read => read.status === 'read').length >= MAX_CONFIG_FILES)) return blocked()
      descriptor = fs.openSync(actual, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
      const opened = fs.fstatSync(descriptor)
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size > maxBytes || fs.realpathSync(path) !== actual) return blocked()
      const buffer = Buffer.alloc(maxBytes + 1)
      let bytes = 0
      while (bytes < buffer.length) {
        const count = fs.readSync(descriptor, buffer, bytes, buffer.length - bytes, null)
        if (!count) break
        bytes += count
      }
      const after = fs.fstatSync(descriptor)
      if (bytes > maxBytes || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) return blocked()
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes))
      if (text.includes('\0')) return blocked()
      if (!policy) configBytes += bytes
      const result: ConfigRead = { status: 'read', text }
      configTexts.set(path, result)
      configurationSnapshot().files[path] = `sha256:${createHash('sha256').update(actual).update('\0').update(text).digest('hex')}`
      return result
    } catch (error) {
      const result: ConfigRead = (error as NodeJS.ErrnoException).code === 'ENOENT' && !observed ? { status: 'missing' } : blocked()
      configTexts.set(path, result)
      if (result.status === 'missing') configurationSnapshot().files[path] = 'missing'
      return result
    } finally {
      if (descriptor !== undefined) try { fs.closeSync(descriptor) } catch { /* Best-effort descriptor cleanup. */ }
    }
  }

  const loadPolicy = (): boolean => {
    if (patterns !== undefined) return !policyBlocked
    patterns = []
    if (!logicalRoot || !realRoot) { failInspection(); policyBlocked = true; return false }
    const policy = readConfig(resolve(logicalRoot, '.madarignore'), true)
    if (policy.status === 'blocked') policyBlocked = true
    if (policy.status === 'read') {
      patterns = policy.text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
      if (patterns.length > MAX_POLICY_PATTERNS) { failInspection(); policyBlocked = true }
    }
    return !policyBlocked
  }

  const compilerOptions = (importer: string): ts.CompilerOptions | null => {
    const start = dirname(importer)
    if (optionsByDirectory.has(start)) return optionsByDirectory.get(start)!
    const fail = (): null => { failInspection(); optionsByDirectory.set(start, null); return null }
    if (!loadPolicy() || !logicalRoot || !withinRoot(start, logicalRoot)) return fail()
    let configPath: string | undefined
    for (let directory = start; withinRoot(directory, logicalRoot); directory = dirname(directory)) {
      for (const name of ['tsconfig.json', 'jsconfig.json']) {
        const candidate = resolve(directory, name)
        const read = readConfig(candidate)
        if (read.status === 'blocked') return fail()
        if (read.status === 'read') { configPath = candidate; break }
      }
      if (configPath || directory === logicalRoot) break
    }
    if (!configPath) { optionsByDirectory.set(start, null); return null }
    const loaded = new Set<string>()
    const active = new Set<string>()
    const collect = (path: string, depth: number): boolean => {
      if (active.has(path) || depth > MAX_CONFIG_DEPTH) return false
      if (loaded.has(path)) return true
      const read = readConfig(path)
      if (read.status !== 'read') return false
      const parsed = ts.parseConfigFileTextToJson(sourceCompilerPath(path), read.text)
      if (parsed.error || !parsed.config || typeof parsed.config !== 'object' || Array.isArray(parsed.config)) return false
      active.add(path)
      const extended: unknown = parsed.config.extends
      const parents = extended === undefined ? [] : typeof extended === 'string' ? [extended] : Array.isArray(extended) ? extended : null
      if (!parents || parents.some(parent => typeof parent !== 'string' || !/^\.\.?\//.test(parent))) return false
      for (const parent of parents as string[]) {
        const parentPath = resolve(dirname(path), parent)
        // TypeScript tries the literal JSON path, then appends .json. Package
        // configuration and ancestor escapes deliberately remain unsupported.
        const target = parentPath.endsWith('.json') ? parentPath : `${parentPath}.json`
        if (!collect(target, depth + 1)) return false
      }
      active.delete(path); loaded.add(path)
      return true
    }
    if (!collect(configPath, 0)) return fail()
    const raw = ts.parseConfigFileTextToJson(sourceCompilerPath(configPath), (configTexts.get(configPath) as { text: string }).text).config
    const host: ts.ParseConfigHost = {
      useCaseSensitiveFileNames: true,
      fileExists: path => configTexts.get(resolve(path))?.status === 'read',
      readFile: path => { const read = configTexts.get(resolve(path)); return read?.status === 'read' ? read.text : undefined },
      // Configuration is not authority to discover or add source files.
      readDirectory: () => [],
    }
    const parsed = ts.parseJsonConfigFileContent({ ...raw, files: [], include: [] }, host, sourceCompilerPath(dirname(configPath)), undefined, sourceCompilerPath(configPath))
    if (parsed.errors.some(error => error.code !== 18002 && error.code !== 18003)) return fail()
    const options = { ...parsed.options, noEmit: true }
    optionsByDirectory.set(start, options)
    return options
  }

  const safeIndexed = (path: string): boolean => {
    if (!indexed.has(path)) return false
    if (readPolicy) {
      if (!readPolicy(path)) return false
      try { if (!readPolicy(path, fs.realpathSync(path))) return false } catch { return false }
    }
    if (!safeSources.has(path)) safeSources.set(path, sourcePathForEvidence(path, rootPath))
    const actual = safeSources.get(path)
    return !!actual && (!logicalRoot || !isDiscoveryPathIgnored(path, logicalRoot, patterns ?? []))
      && (!realRoot || !isDiscoveryPathIgnored(actual, realRoot, patterns ?? []))
  }
  const directories = new Set<string>()
  for (const path of indexed) {
    for (let directory = dirname(path); directory !== dirname(directory); directory = dirname(directory)) {
      if (logicalRoot && !withinRoot(directory, logicalRoot)) break
      directories.add(directory)
      if (directory === logicalRoot) break
    }
  }
  const resolver: SourceModuleResolver = (specifier, importer) => {
    const key = JSON.stringify([importer, specifier])
    if (resolutions.has(key)) return resolutions.get(key)
    let target: string | undefined
    if (specifier.startsWith('.')) {
      if (logicalRoot && !loadPolicy()) { resolutions.set(key, undefined); return undefined }
      // Preserve exact runtime-extension compatibility and exact-path priority.
      const base = resolve(dirname(importer), specifier)
      const extension = extname(base)
      const substitutions = JS_TS_EXTENSION_SUBSTITUTIONS[extension]
      target = substitutions
        ? substitutions.map(suffix => base.slice(0, -extension.length) + suffix).find(safeIndexed)
        : [base, ...EXTENSIONLESS_JS_TS_EXTENSIONS.map(suffix => base + suffix),
          ...EXTENSIONLESS_JS_TS_EXTENSIONS.map(suffix => resolve(base, `index${suffix}`))].find(safeIndexed)
    } else if (!isAbsolute(specifier) && !specifier.startsWith('#')) {
      const options = compilerOptions(importer)
      if (options && (options.baseUrl || options.paths)) {
        const resolved = ts.resolveModuleName(specifier, sourceCompilerPath(importer), options, {
          fileExists: path => safeIndexed(resolve(path)),
          readFile: () => undefined,
          directoryExists: path => directories.has(resolve(path)),
          getCurrentDirectory: () => sourceCompilerPath(logicalRoot ?? '/'),
          getDirectories: () => [],
        }).resolvedModule
        if (resolved && !resolved.isExternalLibraryImport && safeIndexed(resolve(resolved.resolvedFileName))) target = resolve(resolved.resolvedFileName)
      }
    }
    resolutions.set(key, target)
    return target
  }
  resolver.matchesSnapshot = expected => {
    if (!loadPolicy()) return false
    for (const [path, fingerprint] of Object.entries(expected.files)) {
      const read = readConfig(path, path === resolve(logicalRoot!, '.madarignore'))
      if (read.status === 'blocked' || configurationSnapshot().files[path] !== fingerprint) return false
    }
    return configurationSnapshot().cacheable
  }
  return resolver
}
