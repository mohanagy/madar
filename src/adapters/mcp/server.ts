import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Transform, type Readable, type Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import {
  graphArtifactIdentity,
  readGraphArtifactReceipt,
} from '../filesystem/graph-artifact.js'
import { readBuildState } from '../../domain/index/build-state.js'
import {
  failedQueryIndex,
  inspectQueryIndex,
  type QueryIndex,
} from '../../domain/query/index-status.js'
import {
  resolveMadarWorkspace,
  type MadarWorkspace,
} from '../../shared/workspace.js'
import {
  handleMcpProtocolRequest,
  invalidRequest,
  MAX_STDIO_LINE_BYTES,
  parseError,
  requestMethod,
  serverFailure,
  type JsonRpcResponse,
} from './protocol.js'
const MAX_REQUEST_WAIT_MS = 25_000
const READINESS_POLL_MS = 50
const UNAVAILABLE_SUBJECT = 'canonical graph for current workspace'
const DEADLINE = Symbol('deadline')
const OVERSIZED_LINE = '\0madar-oversized-line'
export interface ReconciliationController {
  startupComplete(): boolean
  failureReason(): string | null
  state(): string
  acceptedBuildId(): string | null
  stop(): void
  readonly completed: Promise<void>
}
export type ReconcilerStarter = (
  workspaceRoot: string,
  signal: AbortSignal,
  error: (message: string) => void,
) => Promise<ReconciliationController> | ReconciliationController
export interface McpServerOptions {
  version: string
  input?: Readable
  output?: Writable
  errorOutput?: Writable
  signal?: AbortSignal
  requestWaitMs?: number
  cwd?: string
  reconcilerStarter?: ReconcilerStarter
}
function samePath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return resolve(left) === resolve(right)
  }
}
function unavailableGraphError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') return true
  const message = error instanceof Error ? error.message : ''
  return /not found|does not exist|permission denied/i.test(message)
}
function writeResponse(output: Writable, response: JsonRpcResponse): void {
  output.write(`${JSON.stringify(response)}\n`)
}
function boundedLineInput(): Transform {
  let pending = Buffer.alloc(0)
  let oversized = false
  const append = (segment: Buffer): void => {
    if (oversized) return
    if (pending.length + segment.length > MAX_STDIO_LINE_BYTES) {
      pending = Buffer.alloc(0)
      oversized = true
    } else {
      pending = Buffer.concat([pending, segment])
    }
  }
  const finish = (stream: Transform): void => {
    stream.push(oversized ? `${OVERSIZED_LINE}\n` : Buffer.concat([pending, Buffer.from('\n')]))
    pending = Buffer.alloc(0)
    oversized = false
  }
  return new Transform({
    transform(chunk: Buffer | string, encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
      let start = 0
      for (let cursor = 0; cursor < bytes.length; cursor += 1) {
        if (bytes[cursor] !== 0x0a) continue
        append(bytes.subarray(start, cursor))
        finish(this)
        start = cursor + 1
      }
      append(bytes.subarray(start))
      callback()
    },
    flush(callback) {
      if (pending.length > 0 || oversized) finish(this)
      callback()
    },
  })
}
function unavailableIndex(): QueryIndex {
  return failedQueryIndex('unavailable', UNAVAILABLE_SUBJECT)
}
type QueryIndexCache = {
  identity: string
  acceptedBuildId: string
  index: QueryIndex
}
function readAcceptedQueryIndex(
  workspace: MadarWorkspace,
  controller: ReconciliationController,
  cached: QueryIndexCache | null,
): QueryIndexCache | { index: QueryIndex } {
  try {
    const acceptedBuildId = controller.acceptedBuildId()
    if (
      cached
      && cached.acceptedBuildId === acceptedBuildId
      && cached.identity === graphArtifactIdentity(workspace.graphPath)
    ) return cached
    const receipt = readGraphArtifactReceipt(workspace.graphPath)
    const index = inspectQueryIndex(receipt.graph)
    if (index.state !== 'ready') return { index }
    const build = readBuildState(receipt.graph)
    if (!build
      || !acceptedBuildId
      || build.build_id !== acceptedBuildId
      || !samePath(index.root_path, workspace.rootPath)) {
      return { index: unavailableIndex() }
    }
    return { identity: receipt.identity, acceptedBuildId, index }
  } catch (error) {
    return {
      index: failedQueryIndex(
        unavailableGraphError(error) ? 'unavailable' : 'corrupt',
        unavailableGraphError(error)
          ? UNAVAILABLE_SUBJECT
          : 'canonical graph artifact',
      ),
    }
  }
}
function settleBefore<T>(
  promise: Promise<T>,
  deadline: number,
  signal: AbortSignal,
): Promise<T | typeof DEADLINE> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) return Promise.resolve(DEADLINE)
  return new Promise((resolvePromise, reject) => {
    const finish = (value: T | typeof DEADLINE): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      resolvePromise(value)
    }
    const abort = (): void => finish(DEADLINE)
    const timer = setTimeout(abort, remaining)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void promise.then(finish, (error: unknown) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(error)
    })
  })
}
async function defaultReconcilerStarter(
  workspaceRoot: string,
  signal: AbortSignal,
  reportError: (message: string) => void,
): Promise<ReconciliationController> {
  const reconciler = await import('../../infrastructure/watch-index.js')
  return reconciler.startWatchIndex(workspaceRoot, 1, {
    signal,
    update: reconciler.updateIndexInWorker,
    logger: {
      log() {},
      error(message) {
        reportError(message ?? 'reconciliation failed')
      },
    },
  })
}
class McpRuntime {
  readonly #workspace: MadarWorkspace
  readonly #requestWaitMs: number
  readonly #reportError: (message: string) => void
  readonly #starter: ReconcilerStarter
  readonly #abort = new AbortController()
  #initialized = false
  #toolsListed = false
  #controller: ReconciliationController | null = null
  #queryIndexCache: QueryIndexCache | null = null
  #startFailure: string | null = null
  #startPromise: Promise<ReconciliationController | null> | null = null
  constructor(
    workspace: MadarWorkspace,
    options: {
      requestWaitMs: number
      reportError(message: string): void
      starter: ReconcilerStarter
    },
  ) {
    this.#workspace = workspace
    this.#requestWaitMs = options.requestWaitMs
    this.#reportError = options.reportError
    this.#starter = options.starter
  }
  responseSent(method: string | null): void {
    if (method === 'initialize') this.#initialized = true
    if (method === 'tools/list') this.#toolsListed = true
    if (this.#initialized && this.#toolsListed) void this.#startReconciler()
  }
  #startReconciler(): Promise<ReconciliationController | null> {
    if (this.#startPromise) return this.#startPromise
    this.#startPromise = Promise.resolve()
      .then(async () => await this.#starter(
        this.#workspace.rootPath,
        this.#abort.signal,
        this.#reportError,
      ))
      .then((controller) => {
        this.#controller = controller
        if (this.#abort.signal.aborted) controller.stop()
        return controller
      })
      .catch((error: unknown) => {
        this.#startFailure = error instanceof Error
          ? error.message
          : 'reconciliation failed to start'
        this.#reportError(this.#startFailure)
        return null
      })
    return this.#startPromise
  }
  async loadQueryIndex(arrivalMs: number): Promise<QueryIndex> {
    if (!this.#initialized || !this.#toolsListed || this.#abort.signal.aborted) {
      return unavailableIndex()
    }
    const deadline = arrivalMs + this.#requestWaitMs
    const controller = await settleBefore(
      this.#startReconciler(), deadline, this.#abort.signal,
    )
    if (controller === DEADLINE || controller === null || this.#startFailure) {
      return unavailableIndex()
    }
    while (!this.#abort.signal.aborted && Date.now() < deadline) {
      if (controller.failureReason()) return unavailableIndex()
      const state = controller.state()
      if (controller.startupComplete() && state === 'idle') {
        const result = readAcceptedQueryIndex(
          this.#workspace, controller, this.#queryIndexCache,
        )
        this.#queryIndexCache = 'identity' in result ? result : null
        return result.index
      }
      if (state === 'failed' || state === 'stopped') return unavailableIndex()
      await delay(Math.min(
        READINESS_POLL_MS,
        Math.max(1, deadline - Date.now()),
      ))
    }
    return unavailableIndex()
  }
  async stop(waitForCompletion = true): Promise<void> {
    this.#abort.abort()
    const controller = this.#controller
    if (!controller) return
    controller.stop()
    if (waitForCompletion) await controller.completed
  }
}
export async function serveMcpServer(options: McpServerOptions): Promise<void> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const errorOutput = options.errorOutput ?? process.stderr
  const workspace = resolveMadarWorkspace(options.cwd ?? process.cwd())
  const requestWaitMs = Math.min(
    MAX_REQUEST_WAIT_MS,
    Math.max(0, options.requestWaitMs ?? MAX_REQUEST_WAIT_MS),
  )
  const runtime = new McpRuntime(workspace, {
    requestWaitMs,
    starter: options.reconcilerStarter ?? defaultReconcilerStarter,
    reportError(message) {
      errorOutput.write(`[madar mcp] ${message}\n`)
    },
  })
  const boundedInput = input.pipe(boundedLineInput())
  const lines = createInterface({ input: boundedInput, crlfDelay: Infinity })
  const inFlight = new Set<Promise<void>>()
  const abort = (): void => lines.close()
  options.signal?.addEventListener('abort', abort, { once: true })
  errorOutput.write(`[madar mcp] stdio ready for ${workspace.rootPath}\n`)
  const dispatch = async (
    payload: unknown,
    method: string | null,
    arrivalMs: number,
  ): Promise<void> => {
    let response: JsonRpcResponse | null
    try {
      response = await handleMcpProtocolRequest(payload, {
        version: options.version,
        loadQueryIndex: async () => await runtime.loadQueryIndex(arrivalMs),
      })
    } catch {
      response = serverFailure(payload)
    }
    if (response) {
      writeResponse(output, response)
      runtime.responseSent(method)
    }
  }
  try {
    for await (const line of lines) {
      if (line === OVERSIZED_LINE) {
        writeResponse(
          output,
          invalidRequest(`Payload too large (max ${MAX_STDIO_LINE_BYTES} bytes)`),
        )
        continue
      }
      const trimmed = line.trim()
      if (!trimmed) continue
      let payload: unknown
      try {
        payload = JSON.parse(trimmed)
      } catch {
        writeResponse(output, parseError())
        continue
      }
      const method = requestMethod(payload)
      const task = dispatch(payload, method, Date.now())
      if (method !== 'tools/call') {
        await task
        continue
      }
      inFlight.add(task)
      void task.then(
        () => inFlight.delete(task),
        () => inFlight.delete(task),
      )
    }
  } finally {
    options.signal?.removeEventListener('abort', abort)
    lines.close()
    input.unpipe(boundedInput)
    boundedInput.destroy()
    if (options.signal?.aborted) {
      await runtime.stop(false)
      await Promise.allSettled([...inFlight])
    } else {
      await Promise.allSettled([...inFlight])
      await runtime.stop()
    }
  }
}
