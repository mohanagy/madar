import {
  enqueueJob,
  type PipelineJobPayload,
} from '../pipeline/api/queue-registry.service.js'
import {
  handleQualityGateFailure,
  validateIdeaReportQuality,
} from './quality-gate.service.js'

export async function assembleIdeaReport(
  sections: string[],
  researchedSection: { findings: string },
): Promise<{ content: string }> {
  return {
    content: `${sections.join('|')}:${researchedSection.findings}`,
  }
}

export class AssemblyService {
  async assembleReport(input: PipelineJobPayload): Promise<void> {
    const report = await assembleIdeaReport(
      [input.section ?? 'summary'],
      { findings: input.problem },
    )
    const quality = await validateIdeaReportQuality(report)
    if (!quality.passed) {
      await handleQualityGateFailure(input.ideaId, quality)
      return
    }
    await this.dispatchPersistence({ ...input, report })
  }

  private async dispatchPersistence(input: PipelineJobPayload): Promise<void> {
    await enqueueJob('db-sync-queue', input)
  }
}
