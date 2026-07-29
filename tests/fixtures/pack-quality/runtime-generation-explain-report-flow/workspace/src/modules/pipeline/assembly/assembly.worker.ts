import {
  registerWorker,
  type PipelineJobPayload,
} from '../api/queue-registry.service.js'
import { AssemblyService } from '../../reports/assembly.service.js'

export class AssemblyWorker {
  private readonly assembly = new AssemblyService()

  onModuleInit(): void {
    registerWorker(
      'assembly-queue',
      async (input) => this.process(input),
    )
  }

  async process(input: PipelineJobPayload): Promise<void> {
    await this.assembly.assembleReport(input)
  }
}
