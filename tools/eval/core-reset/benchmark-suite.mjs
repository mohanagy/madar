import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const WARNING = 'bench:suite will execute baseline and madar suite prompts. This may consume paid model tokens.'

function requireValue(flag, value) {
  if (value === undefined || value.trim().length === 0 || value.startsWith('--')) {
    throw new Error(`error: ${flag} requires a value`)
  }
  return value
}

function optionValue(args, index, flag) {
  const argument = args[index]
  if (argument === flag) {
    return { value: requireValue(flag, args[index + 1]), consumed: 2 }
  }
  if (argument?.startsWith(`${flag}=`)) {
    return {
      value: requireValue(flag, argument.split('=', 2)[1]),
      consumed: 1,
    }
  }
  return null
}

function positiveInteger(flag, value) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`error: ${flag} must be a positive integer`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`error: ${flag} must be a positive integer`)
  }
  return parsed
}

export function parseBenchmarkSuiteArgs(args) {
  const options = {
    repo: null,
    task: null,
    reposManifestPath: null,
    tasksManifestPath: null,
    mode: 'all',
    trials: 3,
    outputDir: resolve('docs/benchmarks/suite/results'),
    execTemplate: '',
    dryRun: false,
    yes: false,
  }

  for (let index = 0; index < args.length;) {
    const argument = args[index]
    if (!argument) {
      index += 1
      continue
    }
    if (argument === '--dry-run' || argument === '--yes') {
      options[argument === '--dry-run' ? 'dryRun' : 'yes'] = true
      index += 1
      continue
    }

    const repo = optionValue(args, index, '--repo')
    if (repo) {
      options.repo = repo.value
      index += repo.consumed
      continue
    }
    const task = optionValue(args, index, '--task')
    if (task) {
      options.task = task.value
      index += task.consumed
      continue
    }
    const reposManifest = optionValue(args, index, '--repos-manifest')
    if (reposManifest) {
      options.reposManifestPath = resolve(reposManifest.value)
      index += reposManifest.consumed
      continue
    }
    const tasksManifest = optionValue(args, index, '--tasks-manifest')
    if (tasksManifest) {
      options.tasksManifestPath = resolve(tasksManifest.value)
      index += tasksManifest.consumed
      continue
    }
    const mode = optionValue(args, index, '--mode')
    if (mode) {
      if (!['cold', 'warm', 'all'].includes(mode.value)) {
        throw new Error('error: --mode must be one of cold, warm, all')
      }
      options.mode = mode.value
      index += mode.consumed
      continue
    }
    const trials = optionValue(args, index, '--trials')
    if (trials) {
      options.trials = positiveInteger('--trials', trials.value)
      index += trials.consumed
      continue
    }
    const outputDirectory = optionValue(args, index, '--output-dir')
    if (outputDirectory) {
      options.outputDir = resolve(outputDirectory.value)
      index += outputDirectory.consumed
      continue
    }
    const execTemplate = optionValue(args, index, '--exec')
    if (execTemplate) {
      options.execTemplate = execTemplate.value
      index += execTemplate.consumed
      continue
    }
    throw new Error(`error: unknown option for bench:suite: ${argument}`)
  }

  if (!options.dryRun && options.execTemplate.length === 0) {
    throw new Error('error: --exec is required unless --dry-run is set')
  }
  return options
}

async function confirmed(options) {
  if (options.dryRun || options.yes) return true
  process.stdout.write(`Warning: ${WARNING}\n`)
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('error: bench:suite requires --yes in non-interactive mode.')
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^(?:y|yes)$/i.test((await prompt.question('Continue? [y/N] ')).trim())
  } finally {
    prompt.close()
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseBenchmarkSuiteArgs(args)
  if (!(await confirmed(options))) {
    process.stdout.write('Benchmark suite cancelled.\n')
    return 1
  }

  const evaluatorRoot = process.env.MADAR_BENCH_EVALUATOR_ROOT?.trim()
  if (!evaluatorRoot) {
    throw new Error('error: MADAR_BENCH_EVALUATOR_ROOT is required')
  }
  const suitePath = resolve(
    evaluatorRoot,
    'dist-eval/tools/eval/lib/infrastructure/benchmark/suite.js',
  )
  if (!existsSync(suitePath)) {
    throw new Error(`error: missing benchmark suite module at ${suitePath}`)
  }
  const suite = await import(pathToFileURL(suitePath).href)
  if (typeof suite.runBenchmarkSuite !== 'function') {
    throw new Error(`error: ${suitePath} does not export runBenchmarkSuite`)
  }
  const result = await suite.runBenchmarkSuite(options)
  if (result?.text) process.stdout.write(`${result.text}\n`)
  return 0
}

const direct = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (direct) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`${message.startsWith('error:') ? message : `error: ${message}`}\n`)
      process.exitCode = 1
    },
  )
}
