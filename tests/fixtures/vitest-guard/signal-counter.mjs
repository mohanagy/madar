// Stands in for Vitest to prove the wrapper delivers a terminating signal to the child at most
// once. Unlike controlled-child.mjs's VITEST_GUARD_FIXTURE_SIGNAL self-kill (which proves the
// wrapper *reports* a signal-terminated child correctly), this fixture stays alive after
// receiving a signal instead of dying from it, so a test can observe every delivery this process
// actually received rather than only the first one.
//
// Registering a listener for SIGTERM/SIGINT overrides Node's default (terminate the process), so
// this process keeps running across as many deliveries as arrive during the observation window
// below, then exits on its own -- the test never has to reach in and kill it itself.
let receivedCount = 0

function onSignal(signal) {
  receivedCount += 1
  process.stdout.write(`SIGNAL_RECEIVED ${signal} count=${receivedCount}\n`)
}

process.on('SIGTERM', () => onSignal('SIGTERM'))
process.on('SIGINT', () => onSignal('SIGINT'))

process.stdout.write('SIGNAL_COUNTER_READY\n')

// Long enough for a duplicate delivery to arrive if the wrapper's forwarding is buggy, short
// enough to keep the test fast.
setTimeout(() => {
  process.exit(0)
}, 500)
