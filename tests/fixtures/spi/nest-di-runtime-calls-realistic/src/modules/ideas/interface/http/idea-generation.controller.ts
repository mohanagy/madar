import {
  Body,
  Controller,
  Inject,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common'

import { PipelineTriggerService } from '../../../pipeline/api/pipeline-trigger.service'
import { IdeasService } from '../../core/application/ideas.service'
import { IdeaStatus, type IdeaStatusResponseDto } from '../../core/domain/idea.types'
import { InputValidationService } from '../../infrastructure/services/input-validation.service'
import { ProblemSuggestionService } from '../../infrastructure/services/problem-suggestion.service'
import { TitleGenerationService } from '../../infrastructure/services/title-generation.service'
import { GenerateFromProblemDto } from './dto/generate-from-problem.dto'
import type { AuthenticatedIdeasRequest } from './ideas-authenticated-request'

class AuthGuard {}
class LoggingInterceptor {}
class AppLoggerService {
  log(_: string): void {}
}

function createIdeasControllerLogger(
  appLogger: AppLoggerService,
  context: string,
): { log: (message: string) => void } {
  return {
    log(message: string) {
      appLogger.log(`${context}:${message}`)
    },
  }
}

function requireIdeasUserId(req: AuthenticatedIdeasRequest): string {
  return req.userId
}

@Controller('ideas')
@UseGuards(AuthGuard)
@UseInterceptors(LoggingInterceptor)
export class IdeaGenerationController {
  private readonly logger

  constructor(
    private readonly ideasService: IdeasService,
    private readonly problemSuggestionService: ProblemSuggestionService,
    private readonly titleGenerationService: TitleGenerationService,
    private readonly inputValidationService: InputValidationService,
    @Inject() private readonly pipelineTriggerService: PipelineTriggerService,
    appLogger: AppLoggerService,
  ) {
    this.logger = createIdeasControllerLogger(
      appLogger,
      IdeaGenerationController.name,
    )
  }

  @Post('analyze')
  async generateFromProblem(
    @Body() dto: GenerateFromProblemDto,
    @Req() req: AuthenticatedIdeasRequest,
  ): Promise<IdeaStatusResponseDto> {
    const userId = requireIdeasUserId(req)
    const normalizedProblem = await this.problemSuggestionService.suggestProblem(dto.problem)

    this.inputValidationService.validateProblem(normalizedProblem)

    const idea = await this.ideasService.createIdea(userId, normalizedProblem)

    if (idea.status !== IdeaStatus.DRAFT) {
      this.logger.log('idea-not-draft')
      return {
        ideaId: idea.id,
        status: idea.status,
        message: this.getStatusMessage(idea.status),
      }
    }

    const titleResult = await this.titleGenerationService.generateTitle(
      normalizedProblem,
      userId,
      idea.id,
    )

    await this.ideasService.updateTitle(
      idea.id,
      titleResult.summarizedTitle,
    )

    const pipelineRun = await this.pipelineTriggerService.startPipeline(
      userId,
      normalizedProblem,
      idea.id,
    )

    const claimed = await this.ideasService.claimQueuedPipelineRun(idea.id)

    if (!claimed) {
      await this.pipelineTriggerService.cancelPipeline(
        pipelineRun.jobId,
      )
    }

    return {
      ideaId: idea.id,
      status: IdeaStatus.QUEUED,
      message: this.getStatusMessage(IdeaStatus.QUEUED),
    }
  }

  private getStatusMessage(status: IdeaStatus): string {
    return status
  }
}
