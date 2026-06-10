import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'

import type { RuntimeProofObligationKind, RuntimeProofProfile } from '../../contracts/runtime-proof.js'

function parseRuntimeProofStringArray(
  profileName: string,
  fieldName: string,
  value: unknown,
): string[] {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)
  ) {
    throw new Error(`Malformed runtime proof profile "${profileName}": ${fieldName} must be a non-empty string array`)
  }
  return value.map((entry) => entry.trim())
}

function parseRuntimeProofKind(
  profileName: string,
  obligationId: string,
  value: unknown,
): RuntimeProofObligationKind {
  if (value === 'entrypoint' || value === 'handoff' || value === 'terminal') {
    return value
  }
  throw new Error(
    `Malformed runtime proof profile "${profileName}" obligation "${obligationId}": kind must be entrypoint, handoff, or terminal`,
  )
}

function parseRuntimeProofProfile(profileName: string, value: unknown): RuntimeProofProfile {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Malformed runtime proof profile "${profileName}": expected an object`)
  }
  const profile = value as Record<string, unknown>
  if (typeof profile.prompt !== 'string' || profile.prompt.trim().length === 0) {
    throw new Error(`Malformed runtime proof profile "${profileName}": prompt must be a non-empty string`)
  }
  if (typeof profile.strict_runtime_proof !== 'boolean') {
    throw new Error(`Malformed runtime proof profile "${profileName}": strict_runtime_proof must be a boolean`)
  }
  if (typeof profile.expected_spi !== 'boolean') {
    throw new Error(`Malformed runtime proof profile "${profileName}": expected_spi must be a boolean`)
  }
  if (!Array.isArray(profile.obligations) || profile.obligations.length === 0) {
    throw new Error(`Malformed runtime proof profile "${profileName}": obligations must be a non-empty array`)
  }

  return {
    prompt: profile.prompt.trim(),
    strict_runtime_proof: profile.strict_runtime_proof,
    expected_spi: profile.expected_spi,
    obligations: profile.obligations.map((obligation, index) => {
      if (obligation === null || typeof obligation !== 'object' || Array.isArray(obligation)) {
        throw new Error(`Malformed runtime proof profile "${profileName}": obligation ${index + 1} must be an object`)
      }
      const entry = obligation as Record<string, unknown>
      if (typeof entry.id !== 'string' || entry.id.trim().length === 0) {
        throw new Error(`Malformed runtime proof profile "${profileName}": obligation ${index + 1} id must be a non-empty string`)
      }
      if (typeof entry.label !== 'string' || entry.label.trim().length === 0) {
        throw new Error(`Malformed runtime proof profile "${profileName}" obligation "${entry.id}": label must be a non-empty string`)
      }
      return {
        id: entry.id.trim(),
        label: entry.label.trim(),
        kind: parseRuntimeProofKind(profileName, entry.id.trim(), entry.kind),
        evidence_terms: parseRuntimeProofStringArray(profileName, `obligations.${entry.id}.evidence_terms`, entry.evidence_terms),
      }
    }),
  }
}

export function loadBenchmarkRuntimeProofProfiles(
  questionsPath: string | null | undefined,
): Map<string, RuntimeProofProfile> | null {
  if (!questionsPath) {
    return null
  }
  const configPath = join(dirname(resolve(questionsPath)), 'runtime-proof.json')
  if (!existsSync(configPath)) {
    return null
  }
  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Malformed runtime proof config: expected a JSON object at ${configPath}`)
  }

  return new Map(
    Object.entries(parsed).map(([profileName, profile]) => [profileName, parseRuntimeProofProfile(profileName, profile)]),
  )
}

export function matchBenchmarkRuntimeProofProfile(
  profiles: ReadonlyMap<string, RuntimeProofProfile> | null,
  question: string,
): RuntimeProofProfile | undefined {
  if (profiles === null) {
    return undefined
  }
  return [...profiles.values()].find((profile) => profile.prompt === question)
}
