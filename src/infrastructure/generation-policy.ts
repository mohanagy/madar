import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'

import { loadGraphArtifact } from '../adapters/filesystem/graph-artifact.js'
import {
  CANONICAL_INDEX_FORMAT_VERSION,
  createGenerationPolicy,
  parseGenerationPolicy,
  type GenerationPolicy,
} from '../contracts/generation-policy.js'
import type { IndexingStrictThresholds } from '../contracts/indexing.js'
import { loadManifestMetadata } from '../pipeline/detect.js'
import { DEFAULT_HARD_IGNORE_GLOBS } from '../shared/source-discovery.js'

export interface BuildGenerationPolicyOptions {
  respectGitignore?: boolean
  followSymlinks?: boolean
  indexingStrict?: IndexingStrictThresholds
}

export interface StoredPolicyGenerationOptions {
  respectGitignore: boolean
  followSymlinks: boolean
  indexingStrict?: IndexingStrictThresholds
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
    const repositoryRoot = optionalGitPath(rootPath, ['rev-parse', '--show-toplevel'])
    if (!repositoryRoot) return null
    const prefix = execFileSync('git', ['-C', rootPath, 'rev-parse', '--show-prefix'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim().replaceAll('\\', '/')
    const output = execFileSync(
      'git',
      ['-C', rootPath, 'ls-files', '--full-name', '--cached', '--others', '-z', '--', ':(top).gitignore', ':(top,glob)**/.gitignore'],
      {
        encoding: 'utf8',
        maxBuffer: 100 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      },
    )
    return [...new Set(output.split('\0').filter(Boolean).filter((path) => path.startsWith(prefix) || prefix.startsWith(path.slice(0, -'.gitignore'.length))).map((repoRelativePath) => {
      const filePath = resolve(repositoryRoot, repoRelativePath)
      const localPath = relative(repositoryRoot, filePath)
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
      controls.push([`gitignore:${resolve(filePath).replaceAll('\\', '/')}`, resolve(filePath)])
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
  gitVisibleFiles: readonly string[] | null,
): GenerationPolicy {
  const strict = options.indexingStrict
  return createGenerationPolicy({
    index_format_version: CANONICAL_INDEX_FORMAT_VERSION,
    respect_gitignore: options.respectGitignore === true,
    follow_symlinks: options.followSymlinks === true,
    exclusion_rules_fingerprint: exclusionRulesFingerprint(rootPath, options.respectGitignore === true, gitVisibleFiles),
    indexing_strict: strict
      ? { max_failed: strict.maxFailed, max_unsupported: strict.maxUnsupported }
      : null,
  })
}

export function generationOptionsFromPolicy(policy: GenerationPolicy): StoredPolicyGenerationOptions {
  const strict = policy.settings.indexing_strict
  return {
    respectGitignore: policy.settings.respect_gitignore,
    followSymlinks: policy.settings.follow_symlinks,
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
  if (!manifestPath) return graphPolicy
  const manifestPolicy = loadManifestMetadata(manifestPath).generation_policy ?? null
  return graphPolicy && manifestPolicy && graphPolicy.fingerprint === manifestPolicy.fingerprint
    ? graphPolicy
    : null
}
