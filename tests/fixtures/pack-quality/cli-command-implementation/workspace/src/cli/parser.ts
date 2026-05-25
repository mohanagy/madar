import { runSyncCommand } from '../commands/sync-command.js'

export function parseSyncArgs(args: string[]) {
  return runSyncCommand(args.includes('--dry-run'))
}
