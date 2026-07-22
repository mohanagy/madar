import { createHash } from 'node:crypto'

import { hasExactKeys, isRecord } from '../shared/guards.js'

export const GENERATION_POLICY_VERSION = 3 as const
export const CANONICAL_INDEX_FORMAT_VERSION = 1 as const

export interface GenerationPolicyStrictThresholds {
  max_failed: number
  max_unsupported: number
}

/** Settings that can change the canonical source corpus or published graph. */
export interface GenerationPolicySettings {
  index_format_version: typeof CANONICAL_INDEX_FORMAT_VERSION
  respect_gitignore: boolean
  follow_symlinks: boolean
  exclusion_rules_fingerprint: string
  indexing_strict: GenerationPolicyStrictThresholds | null
}

export interface GenerationPolicy {
  version: typeof GENERATION_POLICY_VERSION
  fingerprint: string
  settings: GenerationPolicySettings
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function canonicalPolicyDocument(settings: GenerationPolicySettings): string {
  return JSON.stringify({ version: GENERATION_POLICY_VERSION, settings })
}

export function generationPolicyFingerprint(settings: GenerationPolicySettings): string {
  return createHash('sha256').update(canonicalPolicyDocument(settings)).digest('hex')
}

export function createGenerationPolicy(settings: GenerationPolicySettings): GenerationPolicy {
  return {
    version: GENERATION_POLICY_VERSION,
    fingerprint: generationPolicyFingerprint(settings),
    settings,
  }
}

function parseStrictThresholds(value: unknown): GenerationPolicyStrictThresholds | null | undefined {
  if (value === null) return null
  if (!isRecord(value) || !hasExactKeys(value, ['max_failed', 'max_unsupported'])) return undefined
  if (!isNonNegativeInteger(value.max_failed) || !isNonNegativeInteger(value.max_unsupported)) return undefined
  return { max_failed: value.max_failed, max_unsupported: value.max_unsupported }
}

/** Parse and authenticate only the current canonical policy. Older policies fail closed. */
export function parseGenerationPolicy(value: unknown): GenerationPolicy | null {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['version', 'fingerprint', 'settings'])
    || value.version !== GENERATION_POLICY_VERSION
    || !isSha256(value.fingerprint)
    || !isRecord(value.settings)
    || !hasExactKeys(value.settings, [
      'index_format_version', 'respect_gitignore', 'follow_symlinks',
      'exclusion_rules_fingerprint', 'indexing_strict',
    ])
  ) {
    return null
  }

  const strict = parseStrictThresholds(value.settings.indexing_strict)
  if (
    value.settings.index_format_version !== CANONICAL_INDEX_FORMAT_VERSION
    || typeof value.settings.respect_gitignore !== 'boolean'
    || typeof value.settings.follow_symlinks !== 'boolean'
    || !isSha256(value.settings.exclusion_rules_fingerprint)
    || strict === undefined
  ) {
    return null
  }

  const parsed = createGenerationPolicy({
    index_format_version: CANONICAL_INDEX_FORMAT_VERSION,
    respect_gitignore: value.settings.respect_gitignore,
    follow_symlinks: value.settings.follow_symlinks,
    exclusion_rules_fingerprint: value.settings.exclusion_rules_fingerprint,
    indexing_strict: strict,
  })
  return parsed.fingerprint === value.fingerprint ? parsed : null
}
