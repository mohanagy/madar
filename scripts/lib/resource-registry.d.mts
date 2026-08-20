/** Types for the receipt-runner resource registry, so its tests typecheck. */
import type { ChildProcess } from 'node:child_process'

export interface ResourceRegistry {
  register(description: string, cleanup: () => void): number
  release(id: number): boolean
  registerChild(description: string, child: ChildProcess): number
  releaseChild(id: number): void
  terminateChildren(options?: { graceMs?: number }): Promise<Array<{ id: number; description: string }>>
  cleanupAll(): void
  readonly outstanding: readonly string[]
  readonly liveChildren: readonly string[]
  readonly interrupted: boolean
  readonly acceptingWork: boolean
  markInterrupted(): void
  stopAcceptingWork(): void
}

export function createResourceRegistry(options?: {
  onWarning?: (message: string) => void
}): ResourceRegistry

export function installSignalCoordinator(
  registry: ResourceRegistry,
  options?: {
    exit?: (code: number) => void
    graceMs?: number
    onWarning?: (message: string) => void
  },
): () => void

export function worktreeCleanup(repoRoot: string, dir: string): () => void
export function directoryCleanup(dir: string): () => void
