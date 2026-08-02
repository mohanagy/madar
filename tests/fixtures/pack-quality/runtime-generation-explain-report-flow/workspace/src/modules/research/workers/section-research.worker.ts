import { ResearchAgentService } from '../research-agent.service.js'
import {
  type QueueRegistryService,
  type PipelineJobPayload,
} from '../../pipeline/api/queue-registry.service.js'

export class SectionResearchWorker {
  private readonly researchAgent = new ResearchAgentService()

  constructor(private readonly registry: QueueRegistryService) {}

  onModuleInit(): void {
    this.registry.registerWorker(
      'section-research-queue',
      async (job) => this.process(job.data),
    )
  }

  async process(input: PipelineJobPayload): Promise<void> {
    await this.researchAgent.researchSection(input)
  }
}
