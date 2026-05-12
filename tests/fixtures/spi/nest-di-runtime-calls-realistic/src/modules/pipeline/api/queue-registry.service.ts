export class QueueRegistryService {
  async addJob(input: { userId: string; problem: string; ideaId: string }): Promise<{ jobId: string }> {
    return {
      jobId: `${input.userId}:${input.problem}:${input.ideaId}:job`,
    }
  }
}
