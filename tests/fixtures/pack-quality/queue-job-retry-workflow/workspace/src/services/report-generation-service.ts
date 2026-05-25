import { enqueueRetry } from '../queue/report-job-queue.js'

export async function generateReportJob(reportId: string) {
  return enqueueRetry(reportId)
}
