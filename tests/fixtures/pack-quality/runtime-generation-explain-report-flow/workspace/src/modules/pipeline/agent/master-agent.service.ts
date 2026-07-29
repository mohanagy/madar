export class MasterAgentService {
  async call(problem: string): Promise<string> {
    return this.runRound(problem)
  }

  private async runRound(problem: string): Promise<string> {
    return `research:${problem}`
  }
}
