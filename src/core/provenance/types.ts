export interface GraphProvenance {
  capability_id: string
  stage?: string
  [key: string]: unknown
}

export interface GraphProvenanceOptions {
  capabilityId: string
  stage?: string
  sourceFile?: string
  sourceLocation?: string
}

export const DEFAULT_PROVENANCE_STAGE = 'index'

export function createGraphProvenance(options: GraphProvenanceOptions): GraphProvenance {
  const { capabilityId, stage = DEFAULT_PROVENANCE_STAGE, sourceFile, sourceLocation } = options

  return {
    capability_id: capabilityId,
    stage,
    ...(sourceFile ? { source_file: sourceFile } : {}),
    ...(sourceLocation ? { source_location: sourceLocation } : {}),
  }
}
