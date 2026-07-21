import { createHash } from 'node:crypto'

export const LEGACY_GENERATION_POLICY_VERSION = 1 as const
export const GENERATION_POLICY_VERSION = 2 as const

/**
 * The extraction strategy recorded with a graph. `auto` is capability-aware:
 * the canonical index owns supported JS/TS while the temporary legacy
 * companion owns other supported languages. Explicit modes do not fall back.
 */
export const EXTRACTION_MODES = ['auto', 'legacy', 'spi'] as const

export type ExtractionMode = (typeof EXTRACTION_MODES)[number]

export interface GenerationPolicyStrictThresholdsV1 {
  max_failed: number
  max_unsupported: number
}

/**
 * Every setting here can change the graph corpus, extraction semantics, or
 * whether a graph is publishable. Output-only presentation choices deliberately
 * do not belong in this contract.
 */
export interface GenerationPolicySettingsV1 {
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
  version: typeof LEGACY_GENERATION_POLICY_VERSION
  fingerprint: string
  settings: GenerationPolicySettingsV1
}

/**
 * V2 makes the extraction strategy explicit. `use_spi` remains a derived,
 * schema-compatible signal for consumers that distinguish canonical JS/TS
 * indexing from explicit legacy mode; `extraction_mode` is authoritative.
 */
export interface GenerationPolicySettingsV2 {
  use_spi: boolean
  extraction_mode: ExtractionMode
  respect_gitignore: boolean
  follow_symlinks: boolean
  include_documents: boolean
  include_non_code: true
  extractor_cache_version: number
  exclusion_rules_fingerprint: string
  indexing_strict: GenerationPolicyStrictThresholdsV1 | null
}

export interface GenerationPolicyV2 {
  version: typeof GENERATION_POLICY_VERSION
  fingerprint: string
  settings: GenerationPolicySettingsV2
}

export type GenerationPolicy = GenerationPolicyV1 | GenerationPolicyV2

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isGenerationPolicySettingsV2(
  settings: GenerationPolicySettingsV1 | GenerationPolicySettingsV2,
): settings is GenerationPolicySettingsV2 {
  return 'extraction_mode' in settings
}

function canonicalPolicyDocument(settings: GenerationPolicySettingsV1 | GenerationPolicySettingsV2): string {
  const baseSettings = {
    use_spi: settings.use_spi,
    respect_gitignore: settings.respect_gitignore,
    follow_symlinks: settings.follow_symlinks,
    include_documents: settings.include_documents,
    include_non_code: settings.include_non_code,
    extractor_cache_version: settings.extractor_cache_version,
    exclusion_rules_fingerprint: settings.exclusion_rules_fingerprint,
    indexing_strict: settings.indexing_strict,
  }
  return JSON.stringify({
    version: isGenerationPolicySettingsV2(settings)
      ? GENERATION_POLICY_VERSION
      : LEGACY_GENERATION_POLICY_VERSION,
    settings: isGenerationPolicySettingsV2(settings)
      ? { ...baseSettings, extraction_mode: settings.extraction_mode }
      : baseSettings,
  })
}

export function generationPolicyFingerprint(settings: GenerationPolicySettingsV1 | GenerationPolicySettingsV2): string {
  return createHash('sha256').update(canonicalPolicyDocument(settings)).digest('hex')
}

export function createGenerationPolicy(settings: GenerationPolicySettingsV2): GenerationPolicyV2
export function createGenerationPolicy(settings: GenerationPolicySettingsV1): GenerationPolicyV1
export function createGenerationPolicy(
  settings: GenerationPolicySettingsV1 | GenerationPolicySettingsV2,
): GenerationPolicy {
  return {
    version: isGenerationPolicySettingsV2(settings)
      ? GENERATION_POLICY_VERSION
      : LEGACY_GENERATION_POLICY_VERSION,
    fingerprint: generationPolicyFingerprint(settings),
    settings,
  } as GenerationPolicy
}

function isExtractionMode(value: unknown): value is ExtractionMode {
  return value === 'auto' || value === 'legacy' || value === 'spi'
}

function hasValidSharedSettings(settings: Record<string, unknown>): settings is Record<string, unknown> & GenerationPolicySettingsV1 {
  const strict = settings.indexing_strict
  return typeof settings.use_spi === 'boolean'
    && typeof settings.respect_gitignore === 'boolean'
    && typeof settings.follow_symlinks === 'boolean'
    && typeof settings.include_documents === 'boolean'
    && settings.include_non_code === true
    && isNonNegativeInteger(settings.extractor_cache_version)
    && isSha256(settings.exclusion_rules_fingerprint)
    && (strict === null || (
      isRecord(strict)
      && isNonNegativeInteger(strict.max_failed)
      && isNonNegativeInteger(strict.max_unsupported)
    ))
}

function parseStrictThresholds(settings: GenerationPolicySettingsV1): GenerationPolicyStrictThresholdsV1 | null {
  return settings.indexing_strict === null
    ? null
    : settings.indexing_strict
}

/** Parse and authenticate a stored policy. Tampered or partial policies fail closed. */
export function parseGenerationPolicy(value: unknown): GenerationPolicy | null {
  if (
    !isRecord(value)
    || (value.version !== LEGACY_GENERATION_POLICY_VERSION && value.version !== GENERATION_POLICY_VERSION)
    || !isSha256(value.fingerprint)
    || !isRecord(value.settings)
  ) {
    return null
  }

  const settings = value.settings
  if (!hasValidSharedSettings(settings)) {
    return null
  }

  const sharedSettings = {
    use_spi: settings.use_spi,
    respect_gitignore: settings.respect_gitignore,
    follow_symlinks: settings.follow_symlinks,
    include_documents: settings.include_documents,
    include_non_code: true as const,
    extractor_cache_version: settings.extractor_cache_version,
    exclusion_rules_fingerprint: settings.exclusion_rules_fingerprint,
    indexing_strict: parseStrictThresholds(settings),
  }
  const parsed = value.version === LEGACY_GENERATION_POLICY_VERSION
    ? !('extraction_mode' in settings) && createGenerationPolicy(sharedSettings)
    : isExtractionMode(settings.extraction_mode)
      && settings.use_spi === (settings.extraction_mode !== 'legacy')
      ? createGenerationPolicy({ ...sharedSettings, extraction_mode: settings.extraction_mode })
      : null

  return parsed && parsed.fingerprint === value.fingerprint ? parsed : null
}
