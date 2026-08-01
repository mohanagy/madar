import { Queue, Worker, type Job } from 'bullmq'

export type PipelineJobPayload = {
  userId: string
  problem: string
  ideaId: string
  section?: string
  report?: { content: string }
}

export class QueueRegistryService {
  private readonly queues = new Map<string, Queue<PipelineJobPayload>>()

  constructor() {
    this.queues.set(
      'orchestration-queue',
      new Queue<PipelineJobPayload>('orchestration-queue'),
    )
    this.queues.set(
      'section-research-queue',
      new Queue<PipelineJobPayload>('section-research-queue'),
    )
    this.queues.set(
      'assembly-queue',
      new Queue<PipelineJobPayload>('assembly-queue'),
    )
    this.queues.set(
      'db-sync-queue',
      new Queue<PipelineJobPayload>('db-sync-queue'),
    )
  }

  addJob(
    queueName: string,
    jobName: string,
    input: PipelineJobPayload,
  ): Promise<Job<PipelineJobPayload>> {
    const queue = this.queues.get(queueName)
    if (!queue) throw new Error(`Queue not registered: ${queueName}`)
    return queue.add(jobName, input)
  }

  registerWorker(
    queueName: string,
    processor: (job: Job<PipelineJobPayload>) => Promise<unknown>,
  ): Worker<PipelineJobPayload> {
    return new Worker<PipelineJobPayload>(queueName, processor)
  }
}

export const queueRegistry = new QueueRegistryService()

export async function enqueueJob(
  queueName: string,
  jobName: string,
  input: PipelineJobPayload,
): Promise<{ jobId: string }> {
  const job = await queueRegistry.addJob(queueName, jobName, input)
  return {
    jobId: String(job.id),
  }
}
