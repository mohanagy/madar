/** Answerability states, ordered from least to most confident. */
export declare const ANSWERABILITY_ORDER: readonly ['insufficient', 'verify_targets', 'ready_with_caveat', 'ready']

/** States that assert the pack is answerable, and so count as "reporting ready". */
export declare const READY_STATES: ReadonlySet<string>

export declare function answerabilityRank(state: string): number

export interface CommandOutcome {
  readonly ok: boolean
  readonly detail: string | null
  readonly durationMs: number
}

export interface PackOutcome extends CommandOutcome {
  readonly artifact: Record<string, unknown> | null
}

export declare function runGenerate(input: {
  cliPath: string
  targetDir: string
  logPath?: string
}): CommandOutcome

export declare function runPack(input: {
  cliPath: string
  targetDir: string
  prompt: string
  logPath?: string
}): PackOutcome

export interface GraphIdentity {
  readonly header: string
  readonly generation_mode: string | null
  readonly node_count: number | null
  readonly fact_count: number | null
  readonly community_count: number | null
  readonly integrity_receipt_present: boolean
  readonly identity_digest: string
}

export declare function readGraphIdentity(graphPath: string): GraphIdentity

/** One half of the evidence set: the paths and symbols the artifact presents. */
export interface EvidenceSide {
  readonly paths: readonly string[]
  readonly symbols: readonly string[]
}

/**
 * `strict` is material the pack selected; `generous` adds everything it merely
 * points at. Verdicts use `generous`, so a failure cannot be an artefact of a
 * narrow extraction rule.
 */
export interface EvidenceSets {
  readonly strict: EvidenceSide
  readonly generous: EvidenceSide
}

export declare function extractEvidence(artifact: Record<string, unknown>): EvidenceSets

/** Last dot-separated segment, case-sensitive, leading '#' stripped. */
export declare function normaliseSymbol(symbol: string): string

export declare function readAnswerability(artifact: Record<string, unknown>): string | null

/** Strips machine-specific absolute paths from anything retained as evidence. */
export declare function redact(text: string, options?: { targetDir?: string; root?: string }): string
