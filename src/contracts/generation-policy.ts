import { createHash } from 'node:crypto'

export const GENERATION_POLICY_VERSION = 1 as const

export interface GenerationPolicyStrictThresholdsV1 {
  max_failed: number
  max_unsupported: number
}

/**
 * Every setting here can change the graph corpus, extraction semantics, or
 * whether a graph is publishable. Output-only choices such as HTML rendering
 * deliberately do not belong in this contract.
 */
export interface GenerationPolicySettingsV1 {
  directed: boolean
  use_spi: boolean
  respect_gitignore: boolean
  follow_symlinks: boolean
  include_documents: boolean
  include_non_code: true
  extractor_cache_version: number
  exclusion_rules_fingerprint: string
  indexing_strict: GenerationPolicyStrictThresholdsV1 | null
}

export interface GenerationPolicyV1 {
  version: typeof GENERATION_POLICY_VERSION
  fingerprint: string
  settings: GenerationPolicySettingsV1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function canonicalPolicyDocument(settings: GenerationPolicySettingsV1): string {
  return JSON.stringify({
    version: GENERATION_POLICY_VERSION,
    settings: {
      directed: settings.directed,
      use_spi: settings.use_spi,
      respect_gitignore: settings.respect_gitignore,
      follow_symlinks: settings.follow_symlinks,
      include_documents: settings.include_documents,
      include_non_code: settings.include_non_code,
      extractor_cache_version: settings.extractor_cache_version,
      exclusion_rules_fingerprint: settings.exclusion_rules_fingerprint,
      indexing_strict: settings.indexing_strict,
    },
  })
}

export function generationPolicyFingerprint(settings: GenerationPolicySettingsV1): string {
  return createHash('sha256').update(canonicalPolicyDocument(settings)).digest('hex')
}

export function createGenerationPolicy(settings: GenerationPolicySettingsV1): GenerationPolicyV1 {
  return {
    version: GENERATION_POLICY_VERSION,
    fingerprint: generationPolicyFingerprint(settings),
    settings,
  }
}

/** Parse and authenticate a stored policy. Tampered or partial policies fail closed. */
export function parseGenerationPolicy(value: unknown): GenerationPolicyV1 | null {
  if (!isRecord(value) || value.version !== GENERATION_POLICY_VERSION || !isSha256(value.fingerprint) || !isRecord(value.settings)) {
    return null
  }

  const settings = value.settings
  const strict = settings.indexing_strict
  if (
    typeof settings.directed !== 'boolean'
    || typeof settings.use_spi !== 'boolean'
    || typeof settings.respect_gitignore !== 'boolean'
    || typeof settings.follow_symlinks !== 'boolean'
    || typeof settings.include_documents !== 'boolean'
    || settings.include_non_code !== true
    || !isNonNegativeInteger(settings.extractor_cache_version)
    || !isSha256(settings.exclusion_rules_fingerprint)
    || (strict !== null && (
      !isRecord(strict)
      || !isNonNegativeInteger(strict.max_failed)
      || !isNonNegativeInteger(strict.max_unsupported)
    ))
  ) {
    return null
  }

  const parsed = createGenerationPolicy({
    directed: settings.directed,
    use_spi: settings.use_spi,
    respect_gitignore: settings.respect_gitignore,
    follow_symlinks: settings.follow_symlinks,
    include_documents: settings.include_documents,
    include_non_code: true,
    extractor_cache_version: settings.extractor_cache_version,
    exclusion_rules_fingerprint: settings.exclusion_rules_fingerprint,
    indexing_strict: strict === null
      ? null
      : {
          max_failed: strict.max_failed as number,
          max_unsupported: strict.max_unsupported as number,
        },
  })

  return parsed.fingerprint === value.fingerprint ? parsed : null
}

