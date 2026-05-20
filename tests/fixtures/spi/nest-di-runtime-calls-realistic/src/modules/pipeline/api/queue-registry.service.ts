export type PipelineJobPayload = {
  userId: string
  problem: string
  ideaId: string
}

class PipelineQueue {
  async add(
    jobName: string,
    input: PipelineJobPayload,
  ): Promise<{ id: string }> {
    return {
      id: `${input.userId}:${input.problem}:${input.ideaId}:${jobName}`,
    }
  }
}

export class QueueRegistryService {
  private readonly pipelineQueue = new PipelineQueue()

  async addJob(input: PipelineJobPayload): Promise<{ jobId: string }> {
    const job = await this.pipelineQueue.add('pipeline.orchestrator.process', input)
    return {
      jobId: job.id,
    }
  }
}
