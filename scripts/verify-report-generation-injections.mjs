#!/usr/bin/env node
// #660 Slice C — focused falsifiability for the retired report-generation class.
//
// Four injections, no more. Each one restores ONE retired rule into production
// source from a digest-checked byte snapshot, requires a NAMED control to fail,
// and restores the exact bytes and file mode in `finally`. Unrelated failures
// earn no credit: an injection passes only when the control it names fails.
//
// This is deliberately NOT a general mutation framework. It is a fixed list of
// four edits with a fixed expected victim each.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { resolve } from 'node:path'

const PROMPT_PACK = 'src/infrastructure/prompt-pack.ts'
const SLICING = 'src/runtime/retrieve/slicing.ts'
const GATE = 'src/runtime/retrieval-gate.ts'

const CONTROL_FILE = 'tests/unit/report-generation-independence.test.ts'

/** The retired task-phrase classifier, restored verbatim where an injection needs it. */
const RETIRED_CLASSIFIER = `function promptWantsReportGenerationCore(prompt) {
  return /\\b(?:report(?:\\s+generation)?|generated\\s+report|validation\\s+report|final\\s+report|assembly|assemble|synthesis|renderer|render|planner|research|metrics?|scor(?:e|ing)|quality(?:\\s|-)?gate)\\b/i.test(prompt)
}
`

const INJECTIONS = [
  {
    id: 'C1',
    title: 'the fixed report workflow instruction',
    marker: 'SLICE_C_FIXED_REPORT_INSTRUCTION_REINTRODUCED',
    file: PROMPT_PACK,
    control: { file: CONTROL_FILE, name: 'A: report vocabulary alone produces no fixed workflow' },
    apply(source) {
      // Put the retired fixed instruction back, unconditionally, so the
      // vocabulary-only control must observe it.
      const anchor = `  const instructions = [
    'Treat HTTP/controller entrypoints as trigger context, not the full answer.',
  ]`
      if (!source.includes(anchor)) throw new Error('C1 anchor missing')
      return source.replace(
        `      ...answerContractInstructions(input.retrieval),`,
        `      ...answerContractInstructions(input.retrieval),
      'Follow planner, research, assembly, scoring, rendering, and persistence evidence before concluding the flow.',`,
      )
    },
  },
  {
    id: 'C2',
    title: 'a report-generation task-phrase classifier',
    marker: 'SLICE_C_TASK_PHRASE_CLASSIFIER_REINTRODUCED',
    file: SLICING,
    control: { file: CONTROL_FILE, name: 'B: the same repository and task intent yield the same structure' },
    apply(source) {
      // Restore the classifier AND one behaviour it used to gate: a deeper
      // backward policy for report-shaped prompts only.
      const anchor = `  if (!hasMethodAnchor && !pipelinePrompt) {
    return base
  }`
      if (!source.includes(anchor)) throw new Error('C2 anchor missing')
      return source
        .replace('function promptWantsRuntimePipeline(', `${RETIRED_CLASSIFIER}\nfunction promptWantsRuntimePipeline(`)
        .replace(anchor, `${anchor}

  if (broadRuntimeGeneration && pipelinePrompt && promptWantsReportGenerationCore(options.prompt)) {
    return {
      ...base,
      directions: ['backward', 'forward'],
      backward_relations: new Set(['calls', 'enqueues_job', 'controller_route', 'route_handler', 'method']),
      forward_relations: new Set(RUNTIME_FLOW_RELATIONS),
      helper_relations: new Set(['injects', 'depends_on', 'module_provides']),
      backward_depth: Math.max(base.backward_depth, 3),
      forward_depth: Math.max(base.forward_depth, 4),
      runtime_flow_only: true,
    }
  }`)
    },
  },
  {
    id: 'C3',
    title: 'a name-driven anchor score-table entry',
    marker: 'SLICE_C_NAME_DRIVEN_SCORE_TABLE_REINTRODUCED',
    file: SLICING,
    control: { file: CONTROL_FILE, name: 'C: identical structure named after report stages earns no extra structural treatment' },
    apply(source) {
      // One score-table entry: a symbol is paid for being NAMED like a report
      // stage. The same-name/different-semantics control must notice.
      const anchor = `  if (/\\b(?:service|provider|repository|queue|worker|orchestrator)\\b/.test(lower)) value += 1`
      if (!source.includes(anchor)) throw new Error('C3 anchor missing')
      return source.replace(anchor, `${anchor}
  if (/\\b(?:planner|assembly|assemble|renderer|synthesis|scoring|research)\\b/.test(lower)) value += 11`)
    },
  },
  {
    id: 'C4',
    title: 'the reportGenerationShaped gate variant',
    marker: 'SLICE_C_REPORT_GATE_VARIANT_REINTRODUCED',
    file: GATE,
    control: { file: CONTROL_FILE, name: 'A: report vocabulary alone produces no fixed workflow' },
    apply(source) {
      const anchor = `  const strongRuntimeShaped = backendRuntimeShaped`
      if (!source.includes(anchor)) throw new Error('C4 anchor missing')
      return source.replace(anchor, `  const reportGenerationShaped = /\\b(?:idea\\s+report|report\\s+generation|final\\s+report|planner|research|metrics?|scor(?:e|ing)|quality(?:\\s|-)?gate|renderer|synthesis|assemble|assembly)\\b/i.test(lower)
  const strongRuntimeShaped = backendRuntimeShaped || reportGenerationShaped`)
    },
  },
]

/** Thrown when the pre-injection baseline already fails, so the injection is void. */
class SkipInjection extends Error {}

function digest(text) {
  return createHash('sha256').update(text).digest('hex')
}

function untrackedSources() {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'src', 'tests', 'scripts'], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.startsWith('??'))
    .map((line) => line.slice(3).trim())
    .filter((file) => file.length > 0)
}

function runControl(control) {
  try {
    execFileSync('npx', ['vitest', 'run', control.file, '-t', control.name], {
      stdio: 'pipe',
      encoding: 'utf8',
      env: { ...process.env, CI: '1' },
    })
    return { failed: false }
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`
    return { failed: true, output }
  }
}

function main() {
  const results = []
  let allPassed = true

  // Fingerprint the three production files BEFORE any injection. Comparing to
  // git HEAD would be wrong: on a working branch these files legitimately differ
  // from HEAD, so only a self-taken snapshot can prove the harness left nothing
  // behind.
  const startFingerprint = new Map(
    [PROMPT_PACK, SLICING, GATE].map((file) => [file, digest(readFileSync(resolve(file), 'utf8'))]),
  )
  // Untracked files that already exist are the branch's own new files, not this
  // harness's residue. Only files that appear DURING the run count.
  const startUntracked = new Set(untrackedSources())

  for (const injection of INJECTIONS) {
    const path = resolve(injection.file)
    const original = readFileSync(path, 'utf8')
    const originalDigest = digest(original)
    const originalMode = statSync(path).mode

    let outcome
    try {
      // BEFORE anything is mutated, the named control must be GREEN. Without
      // this baseline a control that was already red would hand every injection
      // free credit: the post-injection failure would prove nothing, because the
      // failure was not caused by the injection.
      const before = runControl(injection.control)
      if (before.failed) {
        outcome = { ok: false, detail: 'the named control was ALREADY FAILING before injection — its later failure would prove nothing' }
        throw new SkipInjection()
      }

      const injected = injection.apply(original)
      if (injected === original) throw new Error(`${injection.id}: injection changed nothing`)
      writeFileSync(path, injected)

      // The injected path must actually be REACHED, not merely present.
      const after = runControl(injection.control)
      if (!after.failed) {
        outcome = { ok: false, detail: 'the named control still PASSED with the rule restored — it cannot catch its own mutation' }
      } else {
        // Credit only for the named control failing, not for any failure.
        const named = after.output.includes(injection.control.name)
        outcome = named
          ? { ok: true, detail: `${injection.marker}: named control was green before injection and failed after, as required` }
          : { ok: false, detail: 'a failure occurred but it was not the named control' }
      }
    } catch (error) {
      if (!(error instanceof SkipInjection)) {
        outcome = { ok: false, detail: `injection error: ${error.message}` }
      }
    } finally {
      writeFileSync(path, original)
      chmodSync(path, originalMode)
      const restored = readFileSync(path, 'utf8')
      if (digest(restored) !== originalDigest) {
        console.error(`FATAL ${injection.id}: ${injection.file} was NOT restored to its original bytes`)
        process.exit(2)
      }
    }

    allPassed = allPassed && outcome.ok
    results.push({ injection, outcome })
    console.log(`${outcome.ok ? 'PASS' : 'FAIL'}  ${injection.id}  ${injection.title}`)
    console.log(`      ${outcome.detail}`)
  }

  // Final fingerprint: every touched file is byte-identical to its start state.
  console.log('')
  console.log('Worktree fingerprint for the three production files after restoration:')
  let drifted = false
  for (const [file, expected] of startFingerprint) {
    const actual = digest(readFileSync(resolve(file), 'utf8'))
    const same = actual === expected
    drifted = drifted || !same
    console.log(`  ${same ? 'restored' : 'DRIFTED '} ${file}  sha256 ${actual.slice(0, 16)}`)
  }
  if (drifted) {
    console.error('FATAL: a production file did not return to its pre-injection bytes.')
    process.exit(2)
  }

  // No temporary source or test residue may survive the run.
  const leaked = untrackedSources().filter((file) => !startUntracked.has(file))
  console.log(leaked.length === 0
    ? '  no new untracked residue under src/, tests/ or scripts/'
    : `  UNTRACKED RESIDUE: ${leaked.join(' ')}`)
  if (leaked.length > 0) process.exit(2)

  console.log('')
  console.log(`${results.filter((entry) => entry.outcome.ok).length}/${INJECTIONS.length} focused injections behaved as required.`)
  process.exit(allPassed ? 0 : 1)
}

main()
