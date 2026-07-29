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
      id: `${jobName}:${input.ideaId}`,
    }
  }
}

const pipelineQueue = new PipelineQueue()

export async function enqueueJob(input: PipelineJobPayload): Promise<{ jobId: string }> {
  const job = await pipelineQueue.add('pipeline.orchestrator.process', input)
  return {
    jobId: job.id,
  }
}
