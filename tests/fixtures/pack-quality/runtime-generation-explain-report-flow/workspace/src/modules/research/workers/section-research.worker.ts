import { ResearchAgentService } from '../research-agent.service.js'
import {
  registerWorker,
  type PipelineJobPayload,
} from '../../pipeline/api/queue-registry.service.js'

export class SectionResearchWorker {
  private readonly researchAgent = new ResearchAgentService()

  onModuleInit(): void {
    registerWorker(
      'section-research-queue',
      async (input) => this.process(input),
    )
  }

  async process(input: PipelineJobPayload): Promise<void> {
    await this.researchAgent.researchSection(input)
  }
}
