export type RuntimeProofObligationKind = 'entrypoint' | 'handoff' | 'terminal'

export interface RuntimeProofProfileObligation {
  id: string
  label: string
  kind: RuntimeProofObligationKind
  evidence_terms: string[]
}

export interface RuntimeProofProfile {
  prompt: string
  strict_runtime_proof: boolean
  expected_spi: boolean
  obligations: RuntimeProofProfileObligation[]
}

export interface RuntimeProofObligationEvidence {
  label: string
  source_file: string
  line_number: number
}

export interface RuntimeProofObligationAssessment {
  id: string
  label: string
  kind: RuntimeProofObligationKind
  required: true
  evidence: RuntimeProofObligationEvidence[]
}

export interface RuntimeProofAssessment {
  obligations: RuntimeProofObligationAssessment[]
  missing_obligations: string[]
}
