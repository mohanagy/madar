export class TitleGenerationService {
  async generateTitle(
    problem: string,
    userId: string,
    ideaId: string,
  ): Promise<{ summarizedTitle: string }> {
    return {
      summarizedTitle: `${problem}:${userId}:${ideaId}`,
    }
  }
}
