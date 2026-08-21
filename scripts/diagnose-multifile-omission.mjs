#!/usr/bin/env node
/**
 * Diagnoses why a multi-file Vitest invocation silently omits modules.
 *
 * The same 21-file request produced 12, 17 and 15 executed modules across three
 * invocations, each reporting success. This records the lifecycle for every
 * requested module and reports, per omitted file, the FIRST event that never
 * arrived -- which is what distinguishes a worker-start failure from a
 * discovery/filter exclusion from a scheduling omission.
 *
 * Read-only: it runs tests and writes a report; it changes nothing.
 *
 * Usage:
 *   node scripts/diagnose-multifile-omission.mjs <manifest.json> [--out <file>]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const ROOT = process.cwd()
const [manifestArg, ...rest] = process.argv.slice(2)
const outIndex = rest.indexOf('--out')
const OUT = outIndex >= 0 ? resolve(ROOT, rest[outIndex + 1]) : null

if (manifestArg === undefined) {
  console.error('usage: diagnose-multifile-omission.mjs <manifest.json> [--out <file>]')
  process.exit(2)
}
const manifestPath = resolve(ROOT, manifestArg)
if (!existsSync(manifestPath)) {
  console.error(`manifest not found: ${manifestArg}`)
  process.exit(2)
}

const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
const entries = Array.isArray(parsed) ? parsed : parsed.files
const requested = entries.map((entry) => resolve(ROOT, entry))

/** Lifecycle events, in the order a healthy module should produce them. */
const STAGES = ['specificationResolved', 'queued', 'collected', 'started', 'finished', 'reported']
const lifecycle = new Map(requested.map((id) => [id, { errors: [] }]))
const poolErrors = []

const mark = (moduleId, stage, detail = true) => {
  const id = resolve(ROOT, moduleId)
  if (!lifecycle.has(id)) lifecycle.set(id, { errors: [], unexpected: true })
  lifecycle.get(id)[stage] = detail
}

const { createVitest } = await import('vitest/node')

const recorder = {
  onInit() {},
  onPathsCollected(paths) {
    for (const path of paths ?? []) mark(path, 'collected')
  },
  onCollected(files) {
    for (const file of files ?? []) mark(file.filepath, 'queued')
  },
  onTestModuleQueued(testModule) {
    if (testModule?.moduleId) mark(testModule.moduleId, 'queued')
  },
  onTestModuleStart(testModule) {
    if (testModule?.moduleId) mark(testModule.moduleId, 'started')
  },
  onTestModuleEnd(testModule) {
    if (testModule?.moduleId) mark(testModule.moduleId, 'finished')
  },
  onTaskUpdate() {},
  onUserConsoleLog() {},
  onTestRunEnd(testModules, unhandledErrors) {
    for (const testModule of testModules ?? []) {
      if (testModule?.moduleId) mark(testModule.moduleId, 'reported')
    }
    for (const error of unhandledErrors ?? []) {
      poolErrors.push(String(error?.message ?? error))
    }
  },
}

const vitest = await createVitest('test', {
  watch: false,
  run: true,
  passWithNoTests: false,
  reporters: [recorder],
})

let report
try {
  const all = await vitest.globTestSpecifications()
  const byModule = new Map()
  for (const specification of all) {
    const id = specification.moduleId
    if (!byModule.has(id)) byModule.set(id, [])
    byModule.get(id).push(specification)
  }

  const specifications = []
  for (const id of requested) {
    const specs = byModule.get(id) ?? []
    if (specs.length > 0) {
      mark(id, 'specificationResolved', specs.length)
      specifications.push(...specs)
    }
  }

  await vitest.runTestSpecifications(specifications, false)

  const files = vitest.state.getFiles()
  for (const file of files) mark(file.filepath, 'reported')

  const executed = new Set(files.map((file) => file.filepath))
  const omitted = requested.filter((id) => !executed.has(id))

  report = {
    manifest: relative(ROOT, manifestPath),
    requestedCount: requested.length,
    specificationCount: specifications.length,
    executedCount: executed.size,
    omittedCount: omitted.length,
    poolErrors,
    omitted: omitted.map((id) => {
      const events = lifecycle.get(id) ?? { errors: [] }
      // The first stage that never arrived is the diagnostic: no specification
      // means discovery excluded it; queued-but-never-started points at the
      // pool; started-but-never-finished points at the worker.
      const firstMissing = STAGES.find((stage) => events[stage] === undefined) ?? null
      return {
        file: relative(ROOT, id),
        firstMissingStage: firstMissing,
        reached: STAGES.filter((stage) => events[stage] !== undefined),
        errors: events.errors,
      }
    }),
    executed: [...executed].map((id) => relative(ROOT, id)).sort(),
  }
} finally {
  await vitest.close()
}

const rendered = JSON.stringify(report, null, 2)
if (OUT !== null) writeFileSync(OUT, `${rendered}\n`)

console.log(`requested        ${report.requestedCount}`)
console.log(`specifications   ${report.specificationCount}`)
console.log(`executed         ${report.executedCount}`)
console.log(`omitted          ${report.omittedCount}`)
if (report.poolErrors.length > 0) {
  console.log('pool/unhandled errors:')
  for (const error of report.poolErrors) console.log(`  ${error}`)
}
for (const entry of report.omitted) {
  console.log(`  ${entry.file}`)
  console.log(`    first missing stage: ${entry.firstMissingStage ?? '(none — reached every stage)'}`)
  console.log(`    reached: ${entry.reached.join(' -> ') || '(nothing)'}`)
}
if (OUT !== null) console.log(`\nreport: ${relative(ROOT, OUT)}`)
process.exit(0)
