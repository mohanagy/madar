import { LlmProviderResolverService } from '../../../pipeline/providers/llm-provider-resolver.service'

export class TitleGenerationService {
  constructor(private readonly llmProviderResolverService: LlmProviderResolverService) {}

  async generateTitle(
    problem: string,
    userId: string,
    ideaId: string,
  ): Promise<{ summarizedTitle: string }> {
    const title = await this.llmProviderResolverService.callLlm(problem)
    return {
      summarizedTitle: `${title}:${userId}:${ideaId}`,
    }
  }
}
