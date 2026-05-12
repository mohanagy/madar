export class ProblemSuggestionService {
  async suggestProblem(problem: string): Promise<string> {
    return problem.trim()
  }
}
