import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function fail(message) {
  throw new Error(message)
}

// Two independent signals decide the gate, not one, so an absent script can never stay
// optional forever:
//   - contractPresent: does docs/qualification/ (the qualification contract) exist on the
//     checked-out commit? It does not exist on `next` today; it lands with #681, in the same
//     merge that adds the qualify:validate script.
//   - scriptPresent: does package.json define a qualify:validate script?
//
// scriptPresent  -> 'run': execute it for real; the caller must hard-fail on a non-zero exit.
// !scriptPresent && contractPresent -> 'missing': the contract has been declared mandatory but
//   its validator is gone. This must hard-fail -- silently downgrading to a notice here is
//   exactly the "permanently optional gate" this mechanism exists to prevent.
// !scriptPresent && !contractPresent -> 'notice': ordinary pre-#681 state; record and skip.
export function decideQualificationGate({ contractPresent, scriptPresent }) {
  if (scriptPresent) {
    return 'run'
  }
  if (contractPresent) {
    return 'missing'
  }
  return 'notice'
}

function readScriptPresence(packageJsonPath) {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  const scripts = pkg.scripts ?? {}
  return Boolean(scripts['qualify:validate'])
}

function parseArguments(args) {
  const options = { cwd: '.' }
  const cwdIndex = args.indexOf('--cwd')
  if (cwdIndex !== -1) {
    const value = args[cwdIndex + 1]
    if (!value || value.startsWith('--')) {
      fail('--cwd requires a value')
    }
    options.cwd = value
  }
  return options
}

export function runCli(args) {
  const { cwd } = parseArguments(args)
  const contractPresent = existsSync(resolve(cwd, 'docs/qualification'))
  const scriptPresent = readScriptPresence(resolve(cwd, 'package.json'))
  const decision = decideQualificationGate({ contractPresent, scriptPresent })

  if (decision === 'missing') {
    fail('docs/qualification/ (the qualification contract) is present on this commit, but the qualify:validate script is missing from package.json. This gate is mandatory once the contract exists; restore the script before releasing.')
  }

  console.log(`decision=${decision}`)
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isCli) {
  try {
    runCli(process.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Qualification gate check failed: ${message}`)
    process.exitCode = 1
  }
}
