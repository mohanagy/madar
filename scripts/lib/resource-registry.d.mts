/** Types for the receipt-runner resource registry, so its tests typecheck. */
export interface ResourceRegistry {
  register(description: string, cleanup: () => void): number
  release(id: number): boolean
  cleanupAll(): void
  readonly outstanding: readonly string[]
  readonly interrupted: boolean
  markInterrupted(): void
}

export function createResourceRegistry(options?: {
  onWarning?: (message: string) => void
}): ResourceRegistry

export function installSignalCoordinator(
  registry: ResourceRegistry,
  options?: { exit?: (code: number) => void },
): () => void

export function worktreeCleanup(repoRoot: string, dir: string): () => void
export function directoryCleanup(dir: string): () => void
