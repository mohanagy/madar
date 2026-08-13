// Deterministic, real-signal-free exercise of the wrapper's one-shot signal-forwarding latch
// (createSignalForwarder). Calling it twice synchronously reproduces the exact race the latch
// exists to close -- two deliveries arriving before Node would ever have a chance to update
// exitCode/signalCode -- without depending on real OS signal timing, which is a separate,
// necessarily best-effort concern covered by the process-level test in the .test.ts file.
import { createSignalForwarder } from '../../../scripts/run-guarded-vitest.mjs'

function makeFakeChild(overrides = {}) {
  const child = {
    exitCode: null,
    signalCode: null,
    killCalls: [],
    ...overrides,
  }
  child.kill = (signal) => {
    child.killCalls.push(signal)
  }
  return child
}

const alive = makeFakeChild()
const forwardSignal = createSignalForwarder(alive)

const firstResult = forwardSignal('SIGTERM')
const secondResult = forwardSignal('SIGTERM')

process.stdout.write(`FIRST_FORWARD_RESULT=${firstResult}\n`)
process.stdout.write(`SECOND_FORWARD_RESULT=${secondResult}\n`)
process.stdout.write(`KILL_CALL_COUNT=${alive.killCalls.length}\n`)
process.stdout.write(`KILL_CALLS=${JSON.stringify(alive.killCalls)}\n`)

// A separate forwarder instance, so this exercises the exitCode guard itself rather than the
// latch: a child that has already exited must never be signaled, latch or no latch.
const alreadyExited = makeFakeChild({ exitCode: 0 })
const exitedResult = createSignalForwarder(alreadyExited)('SIGTERM')

process.stdout.write(`EXITED_CHILD_FORWARD_RESULT=${exitedResult}\n`)
process.stdout.write(`EXITED_CHILD_KILL_CALL_COUNT=${alreadyExited.killCalls.length}\n`)
