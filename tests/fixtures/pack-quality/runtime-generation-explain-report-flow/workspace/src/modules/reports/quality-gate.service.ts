import { writeRawFailureReport } from '../pipeline/workers/failure-storage.service.js'

export async function validateIdeaReportQuality(report: { content: string }): Promise<{ passed: boolean; reason: string }> {
  return {
    passed: report.content.length > 0,
    reason: 'empty report',
  }
}

export async function handleQualityGateFailure(
  ideaId: string,
  quality: { reason: string },
): Promise<{ saved: boolean }> {
  return writeRawFailureReport(ideaId, quality.reason)
}
