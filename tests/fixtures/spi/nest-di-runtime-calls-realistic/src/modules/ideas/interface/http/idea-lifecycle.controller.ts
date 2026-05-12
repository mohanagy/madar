import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common'

import { requireIdeasUserId, type AuthenticatedIdeasRequest } from './ideas-authenticated-request'

@Controller('ideas/lifecycle')
export class IdeaLifecycleController {
  @Get(':id')
  async getIdea(
    @Param('id') ideaId: string,
    @Req() req: AuthenticatedIdeasRequest,
  ): Promise<string> {
    return `${requireIdeasUserId(req)}:${ideaId}`
  }

  @Get()
  async listIdeas(@Req() req: AuthenticatedIdeasRequest): Promise<string[]> {
    return [requireIdeasUserId(req)]
  }

  @Post('publish')
  async publishIdea(
    @Body() dto: { ideaId: string },
    @Req() req: AuthenticatedIdeasRequest,
  ): Promise<string> {
    return `${requireIdeasUserId(req)}:${dto.ideaId}:published`
  }

  @Post('delete')
  async deleteIdea(
    @Body() dto: { ideaId: string },
    @Req() req: AuthenticatedIdeasRequest,
  ): Promise<string> {
    return `${requireIdeasUserId(req)}:${dto.ideaId}:deleted`
  }
}
