import { enqueueJob } from './queue-registry.service.js'

export async function startPipeline(
  userId: string,
  problem: string,
  ideaId: string,
): Promise<{ jobId: string }> {
  return enqueueJob(
    'orchestration-queue',
    'pipeline.orchestrator.process',
    { userId, problem, ideaId },
  )
}
