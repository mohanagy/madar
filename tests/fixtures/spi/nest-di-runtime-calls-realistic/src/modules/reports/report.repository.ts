export class ReportRepository {
  async save(ideaId: string, score: { total: number }): Promise<{ saved: boolean; ideaId: string; total: number }> {
    return { saved: true, ideaId, total: score.total }
  }
}
