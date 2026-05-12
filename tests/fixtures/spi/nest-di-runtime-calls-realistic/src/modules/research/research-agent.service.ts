export class ResearchAgentService {
  async search(problem: string): Promise<{ summary: string }> {
    return { summary: problem }
  }
}
