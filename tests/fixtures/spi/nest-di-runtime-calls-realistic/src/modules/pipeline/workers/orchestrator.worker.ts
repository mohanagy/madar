import { ReportRepository } from '../../reports/report.repository'
import { ResearchAgentService } from '../../research/research-agent.service'
import { MetricsScoringService } from '../../scoring/metrics-scoring.service'

export class OrchestratorWorker {
  constructor(
    private readonly researchAgentService: ResearchAgentService,
    private readonly metricsScoringService: MetricsScoringService,
    private readonly reportRepository: ReportRepository,
  ) {}

  async process(input: { userId: string; problem: string; ideaId: string }): Promise<{ saved: boolean }> {
    const research = await this.researchAgentService.search(input.problem)
    const score = await this.metricsScoringService.score(research)
    return this.reportRepository.save(input.ideaId, score)
  }
}
