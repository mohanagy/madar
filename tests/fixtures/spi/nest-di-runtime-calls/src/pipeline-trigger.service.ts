import { OrchestratorWorker } from './orchestrator.worker.js'

export class PipelineTriggerService {
  constructor(private readonly orchestratorWorker: OrchestratorWorker) {}

  async startPipeline(problem: string, ideaId: string) {
    return {
      jobId: `${ideaId}:job`,
      result: await this.orchestratorWorker.process({ problem, ideaId }),
    }
  }

  async cancelPipeline(jobId: string) {
    return { cancelled: jobId }
  }
}
