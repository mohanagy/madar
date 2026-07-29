import {
  enqueueJob,
  type PipelineJobPayload,
} from '../pipeline/api/queue-registry.service.js'

export async function planIdeaReport(problem: string): Promise<{ sections: string[] }> {
  return {
    sections: [`summary:${problem}`, 'evidence'],
  }
}

export class PlannerService {
  async plan(input: PipelineJobPayload): Promise<void> {
    const plan = await planIdeaReport(input.problem)
    await this.dispatchWave(input, plan.sections[0] ?? 'summary')
  }

  private async dispatchWave(
    input: PipelineJobPayload,
    section: string,
  ): Promise<void> {
    await enqueueJob('section-research-queue', { ...input, section })
  }
}
