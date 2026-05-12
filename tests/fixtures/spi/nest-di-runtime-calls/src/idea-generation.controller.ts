import { Controller, Post } from '@nestjs/common'

import { GenerateFromProblemDto } from './generate-from-problem.dto.js'
import { IdeasService } from './ideas.service.js'
import { PipelineTriggerService } from './pipeline-trigger.service.js'
import { TitleGenerationService } from './title-generation.service.js'

@Controller('ideas')
export class IdeaGenerationController {
  constructor(
    private readonly ideasService: IdeasService,
    private readonly titleGenerationService: TitleGenerationService,
    private readonly pipelineTriggerService: PipelineTriggerService,
  ) {}

  @Post('analyze')
  async generateFromProblem(dto: GenerateFromProblemDto) {
    const idea = await this.ideasService.createIdea(dto.problem)

    const title = await this.titleGenerationService.generateTitle(
      dto.problem,
      idea.id,
    )

    await this.ideasService.updateTitle(idea.id, title)

    const pipelineRun = await this.pipelineTriggerService.startPipeline(
      dto.problem,
      idea.id,
    )

    const claimed = await this.ideasService.claimQueuedPipelineRun(idea.id)

    if (!claimed) {
      await this.pipelineTriggerService.cancelPipeline(pipelineRun.jobId)
    }

    return {
      ideaId: idea.id,
      message: this.getStatusMessage(idea.status),
    }
  }

  private getStatusMessage(status: string) {
    return status
  }
}
