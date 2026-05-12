import { Controller, Get, Param, Query, Req } from '@nestjs/common'

import { BuildPerspectiveService } from '../../infrastructure/services/build-perspective.service'
import { requireIdeasUserId, type AuthenticatedIdeasRequest } from './ideas-authenticated-request'

@Controller('ideas/artifacts')
export class IdeaArtifactsController {
  constructor(private readonly buildPerspectiveService: BuildPerspectiveService) {}

  @Get('build-perspective')
  async generateBuildPerspective(
    @Query('ideaId') ideaId: string,
    @Req() req: AuthenticatedIdeasRequest,
  ): Promise<string> {
    return this.buildPerspectiveService.generateBuildPerspective(
      requireIdeasUserId(req),
      ideaId,
    )
  }

  @Get('pdf')
  async exportIdeaToPdf(
    @Query('ideaId') ideaId: string,
    @Req() req: AuthenticatedIdeasRequest,
  ): Promise<string> {
    return `${requireIdeasUserId(req)}:${ideaId}:pdf`
  }

  @Get('lets-build')
  async generateLetsBuild(
    @Query('ideaId') ideaId: string,
    @Req() req: AuthenticatedIdeasRequest,
  ): Promise<string> {
    return this.buildPerspectiveService.generateLetsBuild(
      requireIdeasUserId(req),
      ideaId,
    )
  }

  @Get('build-perspective/:id')
  async getBuildPerspective(
    @Param('id') ideaId: string,
    @Req() req: AuthenticatedIdeasRequest,
  ): Promise<string> {
    return this.buildPerspectiveService.getBuildPerspective(
      requireIdeasUserId(req),
      ideaId,
    )
  }
}
