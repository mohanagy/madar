import { processReportRetry } from '../workers/report-worker.js'

export function enqueueRetry(reportId: string) {
  return processReportRetry(reportId)
}
