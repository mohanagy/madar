import { rmSync } from 'node:fs'

const stdout = process.env.VITEST_GUARD_FIXTURE_STDOUT ?? ''
const stderr = process.env.VITEST_GUARD_FIXTURE_STDERR ?? ''

if (stdout) {
  await new Promise((resolve, reject) => {
    process.stdout.write(stdout, (error) => error ? reject(error) : resolve())
  })
}

if (stderr) {
  await new Promise((resolve, reject) => {
    process.stderr.write(stderr, (error) => error ? reject(error) : resolve())
  })
}

if (process.env.VITEST_GUARD_FIXTURE_DELETE_LOG === '1') {
  rmSync(process.env.VITEST_GUARD_LOG_PATH, { force: true })
}

const signal = process.env.VITEST_GUARD_FIXTURE_SIGNAL
if (signal) {
  process.kill(process.pid, signal)
} else {
  process.exitCode = Number(process.env.VITEST_GUARD_FIXTURE_EXIT_CODE ?? '0')
}
