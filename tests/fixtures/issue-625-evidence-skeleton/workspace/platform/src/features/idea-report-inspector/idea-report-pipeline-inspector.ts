function showIdeaTitle(value: string): string {
  return `title:${value}`
}

function showPipelineStage(value: string): string {
  return `stage:${value}`
}

function showPlanningState(value: string): string {
  return `planning:${value}`
}

function showResearchState(value: string): string {
  return `research:${value}`
}

function showAssemblyState(value: string): string {
  return `assembly:${value}`
}

function showPersistenceState(value: string): string {
  return `persistence:${value}`
}

function showQueuedState(value: string): string {
  return `queued:${value}`
}

function showCompletedState(value: string): string {
  return `completed:${value}`
}

function showFailureState(value: string): string {
  return `failure:${value}`
}

function showRetryState(value: string): string {
  return `retry:${value}`
}

function showReportLink(value: string): string {
  return `report:${value}`
}

function showStatusBadge(value: string): string {
  return `status:${value}`
}

export function describeIdeaReportPipelineStagesAssemblyAndPersistence(
  value: string,
): string[] {
  return [
    showIdeaTitle(value),
    showPipelineStage(value),
    showPlanningState(value),
    showResearchState(value),
    showAssemblyState(value),
    showPersistenceState(value),
    showQueuedState(value),
    showCompletedState(value),
    showFailureState(value),
    showRetryState(value),
    showReportLink(value),
    showStatusBadge(value),
  ]
}
