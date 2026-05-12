export class InputValidationService {
  validateProblem(problem: string): void {
    if (problem.trim().length === 0) {
      throw new Error('problem required')
    }
  }
}
