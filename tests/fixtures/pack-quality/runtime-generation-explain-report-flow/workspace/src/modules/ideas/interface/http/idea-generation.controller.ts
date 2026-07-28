import { generateIdeaReportSuggestedNextSteps } from '../../application/helpers/idea-report-suggested-next-steps.helper.js'
import { getIdeaReportStatusMessage } from '../../application/helpers/idea-report-status-message.helper.js'
import { generateIdeaTitle } from '../../application/helpers/idea-title-generation.helper.js'
import { startPipeline } from '../../../pipeline/api/pipeline-trigger.service.js'

function Controller(_path: string): any {
  return () => {}
}

function Post(_path: string): any {
  return () => {}
}

@Controller('ideas')
export class IdeaGenerationController {
  @Post('analyze')
  async generateFromProblem(
    dto: { problem: string; userId: string },
  ): Promise<{ status: string; next_steps: string[]; jobId: string }> {
    generateIdeaTitle(dto.problem)
    const pipelineRun = await startPipeline(
      dto.userId,
      dto.problem,
      'idea-1',
    )

    return this.buildQueuedIdeaReportResponse(dto.problem, pipelineRun.jobId)
  }

  private buildQueuedIdeaReportResponse(
    problem: string,
    jobId: string,
  ): { status: string; next_steps: string[]; jobId: string } {
    return {
      status: getIdeaReportStatusMessage('QUEUED'),
      next_steps: generateIdeaReportSuggestedNextSteps(problem),
      jobId,
    }
  }
}
