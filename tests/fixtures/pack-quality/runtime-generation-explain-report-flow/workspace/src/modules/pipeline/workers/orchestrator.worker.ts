import type { PipelineJobPayload } from '../api/queue-registry.service.js'
import { planIdeaReport } from '../../planning/planner.service.js'
import { processIdeaReportSection } from '../../research/workers/section-research.worker.js'
import { assembleIdeaReport } from '../../reports/assembly.service.js'
import { saveStructuredReport } from './db-sync.worker.js'
import { handleQualityGateFailure, validateIdeaReportQuality } from '../../reports/quality-gate.service.js'

type BullJob<T> = {
  data: T
}

function Processor(_queueName: string): any {
  return () => {}
}

function Process(_jobName: string): any {
  return () => {}
}

@Processor('pipeline.orchestrator')
export class OrchestratorWorker {
  @Process('pipeline.orchestrator.process')
  async process(job: BullJob<PipelineJobPayload>): Promise<{ saved: boolean }> {
    const plan = await planIdeaReport(job.data.problem)
    const researchedSection = await processIdeaReportSection(plan.sections[0] ?? 'summary')
    const report = await assembleIdeaReport(plan.sections, researchedSection)
    const quality = await validateIdeaReportQuality(report)
    if (!quality.passed) {
      return handleQualityGateFailure(job.data.ideaId, quality)
    }
    return saveStructuredReport(job.data.ideaId, report)
  }
}
