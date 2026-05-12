import { OrchestratorWorker } from '../workers/orchestrator.worker'
import { QueueRegistryService } from './queue-registry.service'

export class PipelineTriggerService {
  constructor(
    private readonly orchestratorWorker: OrchestratorWorker,
    private readonly queueRegistryService: QueueRegistryService,
  ) {}

  async startPipeline(
    userId: string,
    problem: string,
    ideaId: string,
  ): Promise<{ jobId: string; result: unknown }> {
    const job = await this.queueRegistryService.addJob({ userId, problem, ideaId })
    return {
      jobId: job.jobId,
      result: await this.orchestratorWorker.process({ userId, problem, ideaId }),
    }
  }

  async cancelPipeline(jobId: string): Promise<{ cancelled: string }> {
    return { cancelled: jobId }
  }
}
