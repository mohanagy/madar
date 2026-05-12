import { OrchestratorWorker } from '../workers/orchestrator.worker'

export class PipelineTriggerService {
  constructor(private readonly orchestratorWorker: OrchestratorWorker) {}

  async startPipeline(
    userId: string,
    problem: string,
    ideaId: string,
  ): Promise<{ jobId: string; result: unknown }> {
    return {
      jobId: `${ideaId}:job`,
      result: await this.orchestratorWorker.process({ userId, problem, ideaId }),
    }
  }

  async cancelPipeline(jobId: string): Promise<{ cancelled: string }> {
    return { cancelled: jobId }
  }
}
