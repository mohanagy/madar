import { syncProject } from '../runtime/sync-project.js'

export function runSyncCommand(dryRun: boolean) {
  return syncProject({ dryRun })
}
