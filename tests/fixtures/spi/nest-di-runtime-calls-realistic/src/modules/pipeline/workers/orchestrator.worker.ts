import type { PipelineJobPayload } from '../api/queue-registry.service'
import { ReportRepository } from '../../reports/report.repository'
import { ResearchAgentService } from '../../research/research-agent.service'
import { MetricsScoringService } from '../../scoring/metrics-scoring.service'

type BullJob<T> = {
  data: T
}

function Processor(_queueName: string): ClassDecorator {
  return () => {}
}

function Process(_jobName: string): MethodDecorator {
  return () => {}
}

@Processor('pipeline.orchestrator')
export class OrchestratorWorker {
  constructor(
    private readonly researchAgentService: ResearchAgentService,
    private readonly metricsScoringService: MetricsScoringService,
    private readonly reportRepository: ReportRepository,
  ) {}

  @Process('pipeline.orchestrator.process')
  async process(job: BullJob<PipelineJobPayload>): Promise<{ saved: boolean }> {
    const research = await this.researchAgentService.search(job.data.problem)
    const score = await this.metricsScoringService.score(research)
    return this.reportRepository.save(job.data.ideaId, score)
  }
}
