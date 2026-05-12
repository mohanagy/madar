export class BuildPerspectiveService {
  async generateBuildPerspective(userId: string, ideaId: string): Promise<string> {
    return `${userId}:${ideaId}:build-perspective`
  }

  async generateLetsBuild(userId: string, ideaId: string): Promise<string> {
    return `${userId}:${ideaId}:lets-build`
  }

  async getBuildPerspective(userId: string, ideaId: string): Promise<string> {
    return `${userId}:${ideaId}:current-build-perspective`
  }
}
