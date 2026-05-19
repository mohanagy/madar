class TagAccumulator {
  add(tag: string, value: string): string {
    return `${tag}:${value}`
  }
}

class DeQueue {
  add(jobName: string, value: string): string {
    return `${jobName}:${value}`
  }
}

export class DiagnosticsService {
  private readonly tagAccumulator = new TagAccumulator()
  private readonly deQueue = new DeQueue()

  recordPipelineStage(stage: string): string {
    return this.tagAccumulator.add('pipeline.orchestrator.process', stage)
  }

  drainPipelineStage(stage: string): string {
    return this.deQueue.add('pipeline.orchestrator.process', stage)
  }
}
