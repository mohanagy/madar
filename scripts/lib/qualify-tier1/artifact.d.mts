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

export interface ChannelSighting {
  readonly schema_path: string
  readonly channel: string
  readonly value: string
}

export interface SnippetSighting {
  readonly schema_path: string
  readonly channel: string
  readonly text: string
}

export interface ObservedChannel {
  readonly channel: string
  readonly role: string
  readonly tier: string | null
  readonly count: number
  readonly sample: string
}

/**
 * `strict` is material the pack selected; `generous` adds everything it merely
 * points at. Verdicts use `generous`, so a failure cannot be an artefact of a
 * narrow extraction rule.
 *
 * `unclassified` is non-empty when the artifact presented a string channel the
 * registry does not classify: closure is a checked property, and a run with an
 * unclassified channel must not be measured.
 */
export interface EvidenceSets {
  readonly strict: EvidenceSide
  readonly generous: EvidenceSide
  /** File names with no directory component; they locate nothing. */
  readonly basename_references: readonly string[]
  readonly snippets: readonly SnippetSighting[]
  readonly unclassified: readonly ChannelSighting[]
  /** Values a channel guard rejected, e.g. a community-shaped workflow center. */
  readonly guarded: readonly ChannelSighting[]
  readonly channels: readonly ObservedChannel[]
}

export declare function extractEvidence(artifact: Record<string, unknown>): EvidenceSets

export interface DeclarationSighting {
  readonly schema_path: string
  readonly channel: string
  readonly text: string
}

/** Channels in which an artifact can say something is absent or unresolved. */
export declare const DECLARATION_CHANNELS: readonly string[]

export declare function extractDeclarations(artifact: Record<string, unknown>): DeclarationSighting[]

/** True when `text` asserts that something is absent, missing or unestablished. */
export declare function assertsAbsence(text: string): boolean

/** Whole-word, case-insensitive containment. Never a substring match. */
export declare function mentionsToken(text: string, token: string): boolean

/** The distinguishing subject terms of a frozen probe prompt. */
export declare function probeSubjectTerms(promptText: string): string[]

/** Reported only: which missing symbols appear in retained snippet text. */
export declare function snippetSymbolSightings(
  evidence: EvidenceSets,
  symbols: readonly string[],
): { symbol: string; schema_path: string }[]

/** The declared channel registry, for reports and controls. */
export declare function declaredChannels(): {
  channel: string
  role: string
  tier: string | null
  reason: string | null
}[]

/** Last dot-separated segment, case-sensitive, leading '#' stripped. */
export declare function normaliseSymbol(symbol: string): string

export declare function readAnswerability(artifact: Record<string, unknown>): string | null

/** Strips machine-specific absolute paths from anything retained as evidence. */
export declare function redact(text: string, options?: { targetDir?: string; root?: string }): string
