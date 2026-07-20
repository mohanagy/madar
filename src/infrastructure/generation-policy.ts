import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'

import { loadGraphArtifact } from '../adapters/filesystem/graph-artifact.js'
import {
  createGenerationPolicy,
  parseGenerationPolicy,
  type ExtractionMode,
  type GenerationPolicy,
  type GenerationPolicyV2,
} from '../contracts/generation-policy.js'
import type { IndexingStrictThresholds } from '../contracts/indexing.js'
import { loadManifestMetadata } from '../pipeline/detect.js'
import { DEFAULT_HARD_IGNORE_GLOBS } from '../shared/source-discovery.js'

export interface BuildGenerationPolicyOptions {
  /**
   * `auto` uses SPI where it has a source-language capability and otherwise
   * falls back to the legacy extractor. Explicit modes stay strict.
   */
  extractionMode?: ExtractionMode
  /** @deprecated Use `extractionMode`. Retained for programmatic callers. */
  useSpi?: boolean
  respectGitignore?: boolean
  followSymlinks?: boolean
  includeDocs?: boolean
  indexingStrict?: IndexingStrictThresholds
}

export interface StoredPolicyGenerationOptions {
  extractionMode: ExtractionMode
  respectGitignore: boolean
  followSymlinks: boolean
  includeDocs: boolean
  indexingStrict?: IndexingStrictThresholds
}

/**
 * Preserve explicit compatibility settings while making auto the shared
 * default for both CLI and programmatic generation.
 */
export function resolveExtractionMode(options: Pick<BuildGenerationPolicyOptions, 'extractionMode' | 'useSpi'>): ExtractionMode {
  if (options.extractionMode !== undefined) {
    return options.extractionMode
  }
  if (options.useSpi !== undefined) {
    return options.useSpi ? 'spi' : 'legacy'
  }
  return 'auto'
}

function optionalGitPath(rootPath: string, args: string[]): string | null {
  try {
    const output = execFileSync('git', ['-C', rootPath, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim()
    return output.length > 0 ? resolve(rootPath, output) : null
  } catch {
    return null
  }
}

function allGitIgnorePaths(rootPath: string): string[] | null {
  try {
    const output = execFileSync(
      'git',
      ['-C', rootPath, 'ls-files', '--cached', '--others', '-z', '--', '.gitignore', ':(glob)**/.gitignore'],
      {
        encoding: 'utf8',
        maxBuffer: 100 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      },
    )
    return [...new Set(output.split('\0').filter(Boolean).map((repoRelativePath) => {
      const filePath = resolve(rootPath, repoRelativePath)
      const localPath = relative(rootPath, filePath)
      if (localPath === '..' || localPath.startsWith(`..${sep}`) || isAbsolute(localPath)) {
        throw new Error('Git returned an exclusion control outside the workspace')
      }
      return filePath
    }))]
  } catch {
    return null
  }
}

function exclusionControlPaths(rootPath: string, respectGitignore: boolean, gitVisibleFiles: readonly string[] | null): Array<[string, string]> {
  const controls: Array<[string, string]> = [['madar:.madarignore', resolve(rootPath, '.madarignore')]]
  if (!respectGitignore) {
    return controls
  }

  const ignoreFiles = allGitIgnorePaths(rootPath)
    ?? (gitVisibleFiles ?? []).filter((filePath) => basename(filePath) === '.gitignore')
  for (const filePath of ignoreFiles) {
    if (basename(filePath) === '.gitignore') {
      controls.push([`gitignore:${relative(rootPath, filePath).replaceAll('\\', '/')}`, resolve(filePath)])
    }
  }

  const repositoryExclude = optionalGitPath(rootPath, ['rev-parse', '--git-path', 'info/exclude'])
  if (repositoryExclude) {
    controls.push(['git:info/exclude', repositoryExclude])
  }
  const globalExclude = optionalGitPath(rootPath, ['config', '--path', '--get', 'core.excludesFile'])
  if (globalExclude) {
    controls.push(['git:core.excludesFile', globalExclude])
  }

  return controls
}

export function exclusionRulesFingerprint(
  rootPath: string,
  respectGitignore: boolean,
  gitVisibleFiles: readonly string[] | null,
): string {
  const hash = createHash('sha256')
  hash.update(JSON.stringify(DEFAULT_HARD_IGNORE_GLOBS))

  const controls = exclusionControlPaths(resolve(rootPath), respectGitignore, gitVisibleFiles)
    .sort(([left], [right]) => left.localeCompare(right))
  for (const [label, filePath] of controls) {
    hash.update('\0').update(label).update('\0')
    if (!existsSync(filePath)) {
      hash.update('missing')
      continue
    }
    try {
      hash.update(readFileSync(filePath))
    } catch {
      hash.update('unreadable')
    }
  }
  return hash.digest('hex')
}

export function buildGenerationPolicy(
  rootPath: string,
  options: BuildGenerationPolicyOptions,
  extractorCacheVersion: number,
  gitVisibleFiles: readonly string[] | null,
): GenerationPolicyV2 {
  const strict = options.indexingStrict
  const extractionMode = resolveExtractionMode(options)
  return createGenerationPolicy({
    use_spi: extractionMode !== 'legacy',
    extraction_mode: extractionMode,
    respect_gitignore: options.respectGitignore === true,
    follow_symlinks: options.followSymlinks === true,
    include_documents: options.includeDocs !== false,
    include_non_code: true,
    extractor_cache_version: extractorCacheVersion,
    exclusion_rules_fingerprint: exclusionRulesFingerprint(rootPath, options.respectGitignore === true, gitVisibleFiles),
    indexing_strict: strict
      ? { max_failed: strict.maxFailed, max_unsupported: strict.maxUnsupported }
      : null,
  })
}

export function generationOptionsFromPolicy(policy: GenerationPolicy): StoredPolicyGenerationOptions {
  const strict = policy.settings.indexing_strict
  return {
    extractionMode: policy.version === 1
      ? policy.settings.use_spi ? 'spi' : 'legacy'
      : policy.settings.extraction_mode,
    respectGitignore: policy.settings.respect_gitignore,
    followSymlinks: policy.settings.follow_symlinks,
    includeDocs: policy.settings.include_documents,
    ...(strict
      ? { indexingStrict: { maxFailed: strict.max_failed, maxUnsupported: strict.max_unsupported } }
      : {}),
  }
}

export function readGraphGenerationPolicy(graphPath: string): GenerationPolicy | null {
  if (!existsSync(graphPath)) {
    return null
  }
  return parseGenerationPolicy(loadGraphArtifact(graphPath).graph.generation_policy)
}

export function readStoredGenerationPolicy(graphPath: string, manifestPath?: string): GenerationPolicy | null {
  const graphPolicy = readGraphGenerationPolicy(graphPath)
  if (!manifestPath) {
    return graphPolicy
  }
  const manifestPolicy = loadManifestMetadata(manifestPath).generation_policy ?? null
  return graphPolicy && manifestPolicy && graphPolicy.fingerprint === manifestPolicy.fingerprint
    ? graphPolicy
    : null
}
