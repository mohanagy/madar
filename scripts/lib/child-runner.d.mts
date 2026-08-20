/** Types for the async child runner, so its tests typecheck. */
import type { ChildProcess } from 'node:child_process'

export interface ChildResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

export interface RunChildOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  registry?: unknown
  description?: string
  graceMs?: number
}

export function terminateChildTree(child: ChildProcess, signal?: NodeJS.Signals): void
export function runChild(command: string, args: readonly string[], options?: RunChildOptions): Promise<ChildResult>
export function runChildOrThrow(command: string, args: readonly string[], options?: RunChildOptions): Promise<ChildResult>
