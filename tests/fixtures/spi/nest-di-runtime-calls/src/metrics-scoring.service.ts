export class MetricsScoringService {
  async score(research: unknown) {
    return { desirability: 7, research }
  }
}
