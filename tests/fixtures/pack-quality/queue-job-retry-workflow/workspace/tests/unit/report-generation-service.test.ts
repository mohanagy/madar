import { describe, expect, it } from 'vitest'

import { generateReportJob } from '../../src/services/report-generation-service.js'

describe('generateReportJob', () => {
  it('queues retry work for report generation', async () => {
    await expect(generateReportJob('report-1')).resolves.toEqual({
      queued: true,
      reportId: 'report-1',
    })
  })
})
