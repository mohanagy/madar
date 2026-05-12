import { IdeaStatus, type IdeaRecord } from '../domain/idea.types'

export class IdeasService {
  async createIdea(userId: string, problem: string): Promise<IdeaRecord> {
    return { id: `${userId}:${problem}`, status: IdeaStatus.DRAFT }
  }

  async updateTitle(ideaId: string, title: string): Promise<{ ideaId: string; title: string }> {
    return { ideaId, title }
  }

  async claimQueuedPipelineRun(ideaId: string): Promise<boolean> {
    return ideaId.length > 0
  }
}
