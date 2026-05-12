import { BadRequestException, Body, Controller, Get, Post, Query, Req } from '@nestjs/common'

import { PipelineTriggerService } from '../../../pipeline/api/pipeline-trigger.service'
import { requireIdeasUserId, type AuthenticatedIdeasRequest } from './ideas-authenticated-request'

@Controller('ideas/pipeline')
export class IdeaPipelineController {
  constructor(private readonly pipelineTriggerService: PipelineTriggerService) {}

  @Get('status')
  async getPipelineStatus(
    @Query('ideaId') ideaId: string,
    @Req() req: AuthenticatedIdeasRequest,
  ): Promise<string> {
    if (!ideaId?.trim()) {
      throw new BadRequestException('ideaId is required')
    }

    return `${requireIdeasUserId(req)}:${ideaId}:status`
  }

  @Post('retry')
  async retryPipeline(
    @Body() dto: { problem: string; ideaId: string },
    @Req() req: AuthenticatedIdeasRequest,
  ): Promise<unknown> {
    if (!dto.ideaId?.trim()) {
      throw new BadRequestException('ideaId is required')
    }
    if (!dto.problem?.trim()) {
      throw new BadRequestException('problem is required')
    }

    return this.pipelineTriggerService.startPipeline(
      requireIdeasUserId(req),
      dto.problem,
      dto.ideaId,
    )
  }
}
