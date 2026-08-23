/** Types for the async child runner, so its tests typecheck. */
import type { ChildProcess } from 'node:child_process'

export interface ChildResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  /**
   * True when the child exited but a descendant kept its stdout/stderr open, so
   * the pipes had to be reclaimed under the bounded drain policy. Surfaced as
   * evidence rather than swallowed: it distinguishes an ordinary success from
   * one that needed intervention.
   */
  readonly descendantsHeldStdio: boolean
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
