export class MetricsScoringService {
  async score(research: { summary: string }): Promise<{ total: number; summary: string }> {
    return { total: research.summary.length, summary: research.summary }
  }
}
