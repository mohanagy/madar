export type PipelineJobPayload = {
  userId: string
  problem: string
  ideaId: string
  section?: string
  report?: { content: string }
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
const workers = new Map<string, (input: PipelineJobPayload) => Promise<unknown>>()

export function registerWorker(
  queueName: string,
  worker: (input: PipelineJobPayload) => Promise<unknown>,
): void {
  workers.set(queueName, worker)
}

export async function enqueueJob(
  queueOrInput: string | PipelineJobPayload,
  suppliedInput?: PipelineJobPayload,
): Promise<{ jobId: string }> {
  if (typeof queueOrInput !== 'string') {
    const job = await pipelineQueue.add('pipeline.orchestrator.process', queueOrInput)
    return { jobId: job.id }
  }
  const job = await pipelineQueue.add(queueOrInput, suppliedInput!)
  return {
    jobId: job.id,
  }
}
