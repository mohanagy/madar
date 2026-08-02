import {
  type QueueRegistryService,
  type PipelineJobPayload,
} from '../api/queue-registry.service.js'
import { PlannerService } from '../../planning/planner.service.js'

type BullJob<T> = {
  data: T
}

function Processor(_queueName: string): any {
  return () => {}
}

function Process(_jobName: string): any {
  return () => {}
}

@Processor('pipeline.orchestrator')
export class OrchestratorWorker {
  private readonly planner = new PlannerService()

  constructor(private readonly registry: QueueRegistryService) {}

  onModuleInit(): void {
    this.registry.registerWorker(
      'orchestration-queue',
      async (job) => this.process(job),
    )
  }

  @Process('pipeline.orchestrator.process')
  async process(job: BullJob<PipelineJobPayload>): Promise<void> {
    await this.planner.plan(job.data)
  }
}
