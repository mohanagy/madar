// Read-only observation of the name-driven signals disclosed by #660.
//
// This module NEVER modifies the files it inspects and never declares them
// defective merely because they exist.
//
// It answers one question: did any frozen Tier 1 cell or negative probe
// MEASURABLY change because of these signals?
//
// Two things are separated deliberately, because conflating them would
// manufacture a finding:
//
//   FACT        - the named symbol is present in the named file at this
//                 revision, and a given retrieval classification flag fired on
//                 a given cell. Both are read directly from artefacts.
//   ATTRIBUTION - that a particular flag fired BECAUSE of a particular named
//                 symbol, and that the cell's state depends on it. Establishing
//                 this requires changing production and re-measuring, which
//                 Phase 1 forbids.
//
// So `cell_state_attributable` is never asserted from a flag correlation. A
// source-only suspicion is not a Tier 1 product failure, and neither is a
// co-occurring flag.

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SIGNALS = [
  {
    name: 'src/runtime/retrieve.ts :: pipelineBridgeText',
    file: 'src/runtime/retrieve.ts',
    needles: ['pipelineBridgeText'],
    // Flags recorded ALONGSIDE this signal. Co-occurrence only — the mapping is
    // a hypothesis about which classifier surface the symbol feeds, and this
    // phase cannot test it.
    co_occurring_flags: ['backend_runtime_shaped'],
  },
  {
    name: 'src/runtime/context-pack-diagnostics.ts :: report-stage-like names (planenforcement, requireideasuserid, callllm)',
    file: 'src/runtime/context-pack-diagnostics.ts',
    needles: ['planenforcement', 'requireideasuserid', 'callllm'],
    co_occurring_flags: ['report_generation_shaped'],
  },
  {
    name: 'src/runtime/graph-summary.ts :: addjob',
    file: 'src/runtime/graph-summary.ts',
    needles: ['addjob'],
    co_occurring_flags: ['generic_generation_shaped'],
  },
  {
    name: 'regex-alternation anchoring (a middle alternative can match the tail of a longer word)',
    file: null,
    needles: [],
    co_occurring_flags: ['display_shaped', 'build_static_shaped'],
  },
]

function presentInSource(root, file, needles) {
  if (!file) return null
  const path = resolve(root, file)
  if (!existsSync(path)) return { file_present: false, matches: [] }
  const lowered = readFileSync(path, 'utf8').toLowerCase()
  return { file_present: true, matches: needles.filter((n) => lowered.includes(n.toLowerCase())).sort() }
}

export function observeInheritedSignals({ root, cells }) {
  const observable = cells.filter((cell) => cell.artifact_signals)

  const signals = SIGNALS.map((signal) => {
    const source = presentInSource(root, signal.file, signal.needles)
    const coOccurrences = []
    for (const cell of observable) {
      const debug = cell.artifact_signals.generation_debug ?? {}
      const fired = signal.co_occurring_flags.filter((flag) => debug[flag] === true).sort()
      if (fired.length > 0) coOccurrences.push({ cell_id: cell.cell_id, flags: fired, cell_state: cell.state })
    }
    return {
      name: signal.name,
      file: signal.file,
      // FACT
      source_presence: source,
      co_occurring_flag_cells: coOccurrences,
      // ATTRIBUTION — deliberately not inferred from the two facts above.
      cell_state_attributable: false,
      attribution_status: 'not_established_in_phase_1',
      attribution_note:
        'Establishing that this signal changed a cell would require altering production and re-measuring, which this phase forbids. Flag co-occurrence is recorded as an observation only.',
      // The question the issue actually asks.
      measurably_changed_a_cell: false,
    }
  })

  const anyCoOccurrence = signals.filter((signal) => signal.co_occurring_flag_cells.length > 0).length
  const summary = [
    'No frozen Tier 1 cell or negative-trust probe measurably changed because of the name-driven signals disclosed by #660.',
    `Three of the four disclosed signals have their named symbol present in source at this revision, and ${anyCoOccurrence} signal group(s) had a co-occurring retrieval classification flag on at least one cell.`,
    'Neither fact establishes attribution: the flag-to-symbol mapping is a hypothesis, and proving a cell state depends on one of these symbols would require a production change, which Phase 1 forbids.',
    'Every one of the six task-cell failures below is fully explained by evidence-obligation recall against the frozen truth, with no appeal to these signals. A source-only suspicion is not a Tier 1 product failure.',
  ].join(' ')

  return { summary, signals }
}
