export class TitleGenerationService {
  async generateTitle(problem: string, ideaId: string) {
    return `${problem}:${ideaId}`
  }
}
