export declare const FORBIDDEN_KNOWLEDGE_IN_PRODUCTION: 'FORBIDDEN_QUALIFICATION_KNOWLEDGE_IN_PRODUCTION'
export declare const FORBIDDEN_KNOWLEDGE_MANIFEST_INVALID: 'FORBIDDEN_KNOWLEDGE_MANIFEST_INVALID'

/** One entry in the versioned manifest, or one imported from the frozen contract. */
export interface ForbiddenKnowledgeRule {
  readonly id: string
  readonly repository: string
  readonly class: 'path' | 'symbol' | 'phrase'
  readonly value: string
  readonly why: string
  /** The file this rule came from: the manifest, or the frozen contract. */
  readonly origin: string
}

/** A narrow, dated, single-file exemption from one rule. */
export interface ForbiddenKnowledgeException {
  readonly id: string
  readonly ruleId: string
  readonly file: string
  readonly why: string
  readonly expires: string
}

export interface ForbiddenKnowledgeManifest {
  readonly ok: boolean
  readonly problems: readonly string[]
  readonly rules: readonly ForbiddenKnowledgeRule[]
  readonly exceptions: readonly ForbiddenKnowledgeException[]
  readonly manifestVersion?: string
}

/** One occurrence of qualification-repository knowledge in production source. */
export interface ForbiddenKnowledgeViolation {
  readonly file: string
  readonly line: number
  /** Where in the file the match sits: a literal, a regex, a template span, an identifier or a comment. */
  readonly site: 'string' | 'regex' | 'template' | 'identifier' | 'comment'
  readonly rule: string
  readonly repository: string
  readonly ruleClass: 'path' | 'symbol' | 'phrase'
  readonly ruleValue: string
  readonly why: string
  readonly raw: string
  readonly normalized: string
  /** Which normalization form matched: whole tokens, the case-flattened form, or both. */
  readonly matchForms: readonly ('tokens' | 'squashed')[]
}

export interface ForbiddenKnowledgeResult {
  readonly ok: boolean
  readonly reason: string | null
  readonly manifestProblems: readonly string[]
  readonly manifestVersion: string | null
  readonly violations: readonly ForbiddenKnowledgeViolation[]
  readonly filesScanned: number
  readonly rulesApplied: number
  readonly unusedExceptions: readonly ForbiddenKnowledgeException[]
}

export interface ForbiddenKnowledgeInput {
  readonly root?: string
  readonly files?: readonly string[]
  readonly manifest?: ForbiddenKnowledgeManifest
  readonly readFile?: (file: string) => string
  /** Overrides "now" for expiry checks; ISO date, tests only. */
  readonly today?: string
}

/** One place in a source file where a name, path or shape can be written down. */
export interface KnowledgeBearingSite {
  readonly kind: 'string' | 'regex' | 'template' | 'identifier' | 'comment'
  readonly text: string
  readonly line: number
}

export declare function tokenForm(value: string): string
export declare function squashForm(value: string): string
export declare function knowledgeBearingSites(sourceText: string, fileName?: string): KnowledgeBearingSite[]
export declare function loadForbiddenKnowledgeManifest(
  root?: string,
  options?: { readonly today?: string },
): ForbiddenKnowledgeManifest
export declare function analyzeForbiddenKnowledge(input?: ForbiddenKnowledgeInput): ForbiddenKnowledgeResult
export declare function formatForbiddenKnowledgeReport(result: ForbiddenKnowledgeResult): string
