import { registerWorker } from '../api/queue-registry.service.js'

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
  return { saved: hasIdeaId(ideaId) && hasReportContent(report) }
}

export class DbSyncWorker {
  onModuleInit(): void {
    registerWorker(
      'db-sync-queue',
      async (input) => this.process(input),
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
