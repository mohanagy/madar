import { Body, Controller, Post, Req } from '@nestjs/common'

import { requireIdeasUserId, type AuthenticatedIdeasRequest } from '../../ideas/interface/http/ideas-authenticated-request'

@Controller('nda-share')
export class NdaShareOwnerController {
  @Post('create')
  async createShare(
    @Body() dto: { ideaId: string },
    @Req() req: AuthenticatedIdeasRequest,
  ): Promise<string> {
    return `${requireIdeasUserId(req)}:${dto.ideaId}:share`
  }

  @Post('sign')
  async signNDA(
    @Body() dto: { ideaId: string },
    @Req() req: AuthenticatedIdeasRequest,
  ): Promise<string> {
    return `${requireIdeasUserId(req)}:${dto.ideaId}:signed`
  }

  @Post('validate')
  async validateShareAccess(
    @Body() dto: { ideaId: string },
    @Req() req: AuthenticatedIdeasRequest,
  ): Promise<boolean> {
    return `${requireIdeasUserId(req)}:${dto.ideaId}`.length > 0
  }
}
