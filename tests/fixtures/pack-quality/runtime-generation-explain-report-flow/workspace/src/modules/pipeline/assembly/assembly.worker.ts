import {
  type QueueRegistryService,
  type PipelineJobPayload,
} from '../api/queue-registry.service.js'
import { AssemblyService } from '../../reports/assembly.service.js'

export class AssemblyWorker {
  private readonly assembly = new AssemblyService()

  constructor(private readonly registry: QueueRegistryService) {}

  onModuleInit(): void {
    this.registry.registerWorker(
      'assembly-queue',
      async (job) => this.process(job.data),
    )
  }

  async process(input: PipelineJobPayload): Promise<void> {
    await this.assembly.assembleReport(input)
  }
}
