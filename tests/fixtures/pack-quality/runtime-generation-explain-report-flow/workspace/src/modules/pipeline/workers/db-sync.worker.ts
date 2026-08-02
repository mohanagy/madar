import type { QueueRegistryService } from '../api/queue-registry.service.js'
import type { MongoRepository } from 'typeorm'

type StoredReport = {
  id: string
  content: string
}

declare const reportRepository: MongoRepository<StoredReport>

function hasIdeaId(ideaId: string): boolean {
  return ideaId.length > 0
}

function hasReportContent(report: { content: string }): boolean {
  return report.content.length > 0
}

export async function saveStructuredReport(
  ideaId: string,
  report: { content: string },
): Promise<{ saved: boolean }> {
  if (!hasIdeaId(ideaId) || !hasReportContent(report)) return { saved: false }
  await reportRepository.update(ideaId, { id: ideaId, content: report.content })
  return { saved: true }
}

export class DbSyncWorker {
  constructor(private readonly registry: QueueRegistryService) {}

  onModuleInit(): void {
    this.registry.registerWorker(
      'db-sync-queue',
      async (job) => this.process(job.data),
    )
  }

  async process(input: {
    ideaId: string
    problem: string
    report?: { content: string }
  }): Promise<{ saved: boolean }> {
    return saveStructuredReport(
      input.ideaId,
      input.report ?? { content: input.problem },
    )
  }
}
