export class LlmProviderResolverService {
  async resolve(prompt: string): Promise<string> {
    return `provider:${prompt.length}`
  }

  async callLlm(prompt: string): Promise<string> {
    const provider = await this.resolve(prompt)
    return `${provider}:${prompt}`
  }
}
