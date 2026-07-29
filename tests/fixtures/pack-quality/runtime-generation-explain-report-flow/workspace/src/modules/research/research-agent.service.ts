import { MasterAgentService } from '../pipeline/agent/master-agent.service.js'
import {
  enqueueJob,
  type PipelineJobPayload,
} from '../pipeline/api/queue-registry.service.js'

export class ResearchAgentService {
  private readonly masterAgent = new MasterAgentService()

  async researchSection(input: PipelineJobPayload): Promise<void> {
    const research = await this.masterAgent.call(input.problem)
    await this.searchIdeaReportSources(input.section ?? research)
    await this.checkAndDispatchNext(input)
  }

  async searchIdeaReportSources(section: string): Promise<{ summary: string }> {
    return {
      summary: `researched:${section}`,
    }
  }

  private async checkAndDispatchNext(input: PipelineJobPayload): Promise<void> {
    await enqueueJob('assembly-queue', input)
  }
}
