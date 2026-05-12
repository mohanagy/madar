export class ReportRepository {
  async save(ideaId: string, score: unknown) {
    return { ideaId, score }
  }
}
