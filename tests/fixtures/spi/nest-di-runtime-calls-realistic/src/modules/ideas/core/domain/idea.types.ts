export enum IdeaStatus {
  DRAFT = 'DRAFT',
  QUEUED = 'QUEUED',
}

export interface IdeaRecord {
  id: string
  status: IdeaStatus
}

export interface IdeaStatusResponseDto {
  ideaId: string
  status: IdeaStatus
  message: string
}
