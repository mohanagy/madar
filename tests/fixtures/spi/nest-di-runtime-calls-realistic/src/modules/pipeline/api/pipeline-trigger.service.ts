import { QueueRegistryService } from './queue-registry.service'

export class PipelineTriggerService {
  constructor(private readonly queueRegistryService: QueueRegistryService) {}

  async startPipeline(
    userId: string,
    problem: string,
    ideaId: string,
  ): Promise<{ jobId: string }> {
    const job = await this.queueRegistryService.addJob({ userId, problem, ideaId })
    return {
      jobId: job.jobId,
    }
  }

  async cancelPipeline(jobId: string): Promise<{ cancelled: string }> {
    return { cancelled: jobId }
  }
}
