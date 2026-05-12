export class IdeasService {
  async createIdea(problem: string) {
    return { id: 'idea-1', status: 'DRAFT', problem }
  }

  async updateTitle(id: string, title: string) {
    return { id, title }
  }

  async claimQueuedPipelineRun(id: string) {
    return id.length > 0
  }
}
