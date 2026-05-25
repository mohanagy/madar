export function processReportRetry(reportId: string) {
  return { queued: true, reportId }
}
