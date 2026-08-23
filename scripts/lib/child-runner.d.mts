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
  /** True when the owned tree needed a force kill before it was empty. */
  readonly forceKilled: boolean
  /** Proof state of the owned process group at settlement. */
  readonly ownedTreeState: string
}

export interface RunChildOptions {
  /**
   * How long the owned process tree may take to be proven empty before the
   * operation fails. Emptiness is a requirement for success, not a courtesy.
   */
  treeReapDeadlineMs?: number
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  registry?: unknown
  description?: string
  graceMs?: number
}

export function terminateChildTree(child: ChildProcess, signal?: NodeJS.Signals): void
/** Raised when an owned process tree cannot be proven empty. */
export class OwnedProcessTreeUnprovableError extends Error {
  readonly code: 'OWNED_PROCESS_TREE_UNPROVABLE'
  constructor(what: string)
}

/** Timers this module currently owns, across every in-flight run. */
export function ownedTimerCount(): number

/** 'empty' | 'populated' | 'unprovable' for the child's owned process group. */
export function ownedTreeState(pid: number | undefined): string

export function runChild(command: string, args: readonly string[], options?: RunChildOptions): Promise<ChildResult>
export function runChildOrThrow(command: string, args: readonly string[], options?: RunChildOptions): Promise<ChildResult>
