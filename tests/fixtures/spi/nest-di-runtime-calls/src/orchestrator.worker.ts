import { MetricsScoringService } from './metrics-scoring.service.js'
import { ReportRepository } from './report.repository.js'
import { ResearchAgentService } from './research-agent.service.js'

export class OrchestratorWorker {
  constructor(
    private readonly researchAgent: ResearchAgentService,
    private readonly scoringService: MetricsScoringService,
    private readonly reportRepository: ReportRepository,
  ) {}

  async process(job: { problem: string; ideaId: string }) {
    const research = await this.researchAgent.search(job.problem)
    const score = await this.scoringService.score(research)
    return this.reportRepository.save(job.ideaId, score)
  }
}
