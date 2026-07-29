export function getStageMessage(idea: { status: string }): string {
  return `idea:${idea.status}`
}
