// Machine-readable result, semantic digest, and the concise human report.

import { createHash } from 'node:crypto'

/**
 * Fields excluded from the semantic digest because they are legitimately
 * volatile between two independently prepared runs. Everything else — the cell
 * population, every state, every expected and observed set, every metric — is
 * inside the digest, so a semantic change cannot hide behind a timestamp.
 */
export const VOLATILE_FIELDS = [
  'generated_at',
  'run_id',
  'duration_ms',
  'output_dir',
  'target_dir',
  'log_path',
  'environment',
  'timings',
]

function semanticView(cell) {
  return {
    cell_id: cell.cell_id,
    kind: cell.kind,
    target_id: cell.target_id,
    target_sha: cell.target_sha,
    patch_digest: cell.patch_digest,
    task_id: cell.task_id ?? null,
    prompt_sha256: cell.prompt_sha256,
    truth_version: cell.truth_version,
    state: cell.state,
    reasons: cell.reasons,
    expected: cell.expected,
    observed: cell.observed,
    metrics: cell.metrics,
    graph_identity: cell.graph_identity
      ? {
          header: cell.graph_identity.header,
          generation_mode: cell.graph_identity.generation_mode,
          node_count: cell.graph_identity.node_count,
          fact_count: cell.graph_identity.fact_count,
          community_count: cell.graph_identity.community_count,
          integrity_receipt_present: cell.graph_identity.integrity_receipt_present,
          identity_digest: cell.graph_identity.identity_digest,
        }
      : null,
    preparation: cell.preparation
      ? {
          valid: cell.preparation.valid,
          invalid_reason: cell.preparation.invalid_reason,
          head: cell.preparation.head,
          patch_applied: cell.preparation.patch_applied,
          cited_blobs_verified: cell.preparation.cited_blobs_verified,
          cited_blobs_total: cell.preparation.cited_blobs_total,
        }
      : null,
  }
}

export function semanticDigest(result) {
  const view = {
    contract_version: result.contract_version,
    frozen_manifest_digest: result.frozen_input_manifest.digest,
    // A result produced under a different adjudication contract is a different
    // measurement, so the contract identity is inside the digest. Results from
    // the old prose evaluator can never compare equal to these.
    adjudication_contract_digest: result.adjudication_contract?.digest ?? null,
    madar_revision: result.madar.revision,
    cells: result.cells.map(semanticView).sort((a, b) => a.cell_id.localeCompare(b.cell_id)),
  }
  return createHash('sha256').update(JSON.stringify(view)).digest('hex')
}

export function renderReport(result) {
  const lines = []
  const counts = result.totals
  lines.push('# Tier 1 qualification — first independent baseline')
  lines.push('')
  lines.push('> **First Tier 1 measurement — gate not yet activated**')
  lines.push('>')
  lines.push('> Thresholds in this contract are pre-registered and uncalibrated. A failing cell here is a')
  lines.push('> product finding to be triaged by a maintainer, not a reason to edit the frozen contract.')
  lines.push('> `sealed holdout unsatisfied; results measure regression only`.')
  lines.push('')
  lines.push('## Totals')
  lines.push('')
  lines.push('| Result | Count |')
  lines.push('| --- | --- |')
  lines.push(`| pass | ${counts.pass} |`)
  lines.push(`| fail | ${counts.fail} |`)
  lines.push(`| invalid | ${counts.invalid} |`)
  lines.push('')
  lines.push('Invalid cells are reported separately and are never folded into a quality percentage.')
  lines.push('')
  lines.push('## Identity')
  lines.push('')
  lines.push(`- Contract version: \`${result.contract_version}\``)
  lines.push(`- Frozen-input manifest: ${result.frozen_input_manifest.file_count} files, digest \`${result.frozen_input_manifest.digest}\``)
  lines.push(`- Madar revision: \`${result.madar.revision}\` (version \`${result.madar.version}\`)`)
  lines.push(`- Semantic digest: \`${result.semantic_digest}\``)
  lines.push('')
  lines.push('## Per-cell results')
  lines.push('')
  lines.push('| Cell | Kind | Target | Target SHA | State | Path recall | Symbol recall | Answerability |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const cell of result.cells) {
    const paths = cell.metrics?.critical_fact_recall?.paths
    const symbols = cell.metrics?.critical_fact_recall?.symbols
    lines.push([
      '',
      `\`${cell.cell_id}\``,
      cell.kind,
      `\`${cell.target_id}\``,
      `\`${(cell.target_sha ?? '—').slice(0, 12)}\``,
      `**${cell.state}**`,
      paths ? `${paths.matched}/${paths.required} (${paths.ratio.toFixed(2)})` : '—',
      symbols ? `${symbols.matched}/${symbols.required} (${symbols.ratio.toFixed(2)})` : '—',
      `\`${cell.observed?.answerability ?? '—'}\``,
      '',
    ].join(' | ').trim())
  }
  lines.push('')
  lines.push('## Per-cell detail')
  for (const cell of result.cells) {
    lines.push('')
    lines.push(`### \`${cell.cell_id}\` — ${cell.state}`)
    lines.push('')
    lines.push(`- Target \`${cell.target_id}\` at \`${cell.target_sha ?? '—'}\``)
    if (cell.patch_digest) lines.push(`- Patch digest \`${cell.patch_digest}\``)
    lines.push(`- Prompt SHA-256 \`${cell.prompt_sha256}\``)
    lines.push(`- Truth version \`${cell.truth_version}\``)
    if (cell.expected?.critical_files) {
      lines.push(`- Expected critical files: ${cell.expected.critical_files.map((v) => `\`${v}\``).join(', ') || '—'}`)
      lines.push(`- Observed critical files: ${cell.observed.critical_files.map((v) => `\`${v}\``).join(', ') || '**none**'}`)
      lines.push(`- Missing critical files: ${cell.observed.missing_critical_files.map((v) => `\`${v}\``).join(', ') || '—'}`)
      lines.push(`- Expected critical symbols: ${cell.expected.critical_symbols.map((v) => `\`${v}\``).join(', ') || '—'}`)
      lines.push(`- Observed critical symbols: ${cell.observed.critical_symbols.map((v) => `\`${v}\``).join(', ') || '**none**'}`)
      lines.push(`- Missing critical symbols: ${cell.observed.missing_critical_symbols.map((v) => `\`${v}\``).join(', ') || '—'}`)
    }
    lines.push(`- Observed answerability: \`${cell.observed?.answerability ?? '—'}\``)
    lines.push(`- Unsupported claims / citation failures: ${cell.metrics?.unsupported_claims ?? 0} / ${cell.metrics?.citation_evidence_failures ?? 0}`)
    if (cell.observed?.evidence_paths_generous) {
      lines.push(`- Evidence set actually presented (generous): ${cell.observed.evidence_paths_generous.map((v) => `\`${v}\``).join(', ') || '—'}`)
    }
    if (cell.reasons?.length) {
      lines.push('- Reasons:')
      for (const reason of cell.reasons) lines.push(`  - ${reason}`)
    }
    if (cell.observed?.ungrounded_symbols?.length) {
      lines.push(`- Symbols not found in the pinned target (reported only — the frozen task method gates on cited paths, not symbols): ${cell.observed.ungrounded_symbols.map((v) => `\`${v}\``).join(', ')}`)
    }
    if (cell.observed?.fabricated_symbols?.length) {
      lines.push(`- Fabricated symbols in the evidence set: ${cell.observed.fabricated_symbols.map((v) => `\`${v}\``).join(', ')}`)
    }
    if (cell.observed?.required_symbols_seen_only_in_snippets?.length) {
      lines.push(`- Required symbols visible ONLY in retained snippet text (reported, never counted): ${cell.observed.required_symbols_seen_only_in_snippets.map((entry) => `\`${entry.symbol}\` at \`${entry.schema_path}\``).join(', ')}`)
    }
    if (cell.ready_clauses?.applicable) {
      lines.push(`- must_not_report_ready_when: ${cell.ready_clauses.violated.length} violated, ${cell.ready_clauses.undetermined.length} undetermined`)
      for (const clause of cell.ready_clauses.violated) lines.push(`  - **violated**: ${clause}`)
      for (const clause of cell.ready_clauses.undetermined) lines.push(`  - undetermined: ${clause}`)
    }
    if (cell.requirement_coverage?.length) {
      lines.push('- Frozen required_behaviour coverage:')
      for (const entry of cell.requirement_coverage) {
        const verdict = entry.measured ? (entry.satisfied ? 'satisfied' : '**not satisfied**') : '**not measured**'
        lines.push(`  - ${verdict} — ${entry.requirement} _(${entry.how})_`)
      }
    }
    if (cell.observed?.absence_declaration) {
      const absence = cell.observed.absence_declaration
      lines.push(`- Absence declaration: ${absence.observed ? 'observed' : '**not observed**'} across ${absence.channels_searched.length} declaration channel(s); ${absence.declarations_seen} declaration string(s) searched for subject terms ${absence.subject_terms.map((v) => `\`${v}\``).join(', ')}`)
      for (const match of absence.matches.slice(0, 4)) lines.push(`  - \`${match.schema_path}\` matched \`${match.term}\`: ${match.text}`)
      for (const near of (absence.subject_mentioned_without_asserting_absence ?? []).slice(0, 4)) {
        lines.push(`  - named the subject but asserted presence, so it is not a declaration: \`${near.schema_path}\` — ${near.text}`)
      }
    }
    if (cell.adjudication?.relationships) {
      const rel = cell.adjudication.relationships
      lines.push('- Frozen relationships:')
      lines.push(`  - required: ${rel.required_relationship_ids.map((v) => `\`${v}\``).join(', ') || '—'}`)
      lines.push(`  - present: ${rel.present_relationship_ids.map((v) => `\`${v}\``).join(', ') || '**none**'}`)
      lines.push(`  - missing: ${rel.missing_relationship_ids.map((v) => `\`${v}\``).join(', ') || '—'}`)
      lines.push(`  - exactly unresolved: ${rel.exactly_unresolved_relationship_ids.map((v) => `\`${v}\``).join(', ') || '—'}`)
      lines.push(`  - uncovered: ${rel.uncovered_relationship_ids.map((v) => `\`${v}\``).join(', ') || '—'}`)
      lines.push(`  - direction(s) evaluated: ${rel.directions_evaluated.join(', ')}; relation kind(s): ${rel.relation_kinds_evaluated.join(', ')}`)
      lines.push(`  - channels consulted: ${rel.channels_consulted.map((v) => `\`${v}\``).join(', ')} (${rel.typed_edges_observed} typed edge(s) observed)`)
      lines.push(`  - false-ready decision: **${rel.false_ready_decision}**`)
    }
    if (cell.evidence_reference) lines.push(`- Evidence: \`${cell.evidence_reference}\``)
  }
  lines.push('')
  lines.push('## Evidence surface')
  lines.push('')
  if (result.evidence_surface) {
    const declared = result.evidence_surface.declared_channels
    const counts = declared.reduce((totals, entry) => ({ ...totals, [entry.role]: (totals[entry.role] ?? 0) + 1 }), {})
    lines.push(`The consumer-visible evidence surface is declared channel by channel in \`scripts/lib/qualify-tier1/channels.mjs\`: ${declared.length} channels — ${Object.entries(counts).sort().map(([role, count]) => `${count} ${role}`).join(', ')}.`)
    lines.push('')
    lines.push(`A run refuses to measure a cell whose artifact presents a channel the registry does not classify, so closure is a checked property rather than a claim. Closed on this run: **${result.evidence_surface.closed ? 'yes' : 'no'}**.`)
    if (!result.evidence_surface.closed) {
      lines.push('')
      for (const failure of result.evidence_surface.unclassified) {
        lines.push(`- \`${failure.cell_id}\`: ${failure.unclassified.map((entry) => `\`${entry.channel}\``).join(', ')}`)
      }
    }
    lines.push('')
    lines.push('| Channel | Role | Tier | Why ignored |')
    lines.push('| --- | --- | --- | --- |')
    for (const entry of declared.filter((channel) => channel.role !== 'ignored')) {
      lines.push(`| \`${entry.channel}\` | ${entry.role} | ${entry.tier ?? '—'} | — |`)
    }
    lines.push('')
    lines.push('<details><summary>Channels deliberately not treated as evidence</summary>')
    lines.push('')
    lines.push('| Channel | Reason |')
    lines.push('| --- | --- |')
    for (const entry of declared.filter((channel) => channel.role === 'ignored')) {
      lines.push(`| \`${entry.channel}\` | ${entry.reason ?? '—'} |`)
    }
    lines.push('')
    lines.push('</details>')
  }
  lines.push('')
  lines.push('## Run independence')
  lines.push('')
  if (result.run_independence) {
    lines.push(`Generated state for this arm lives under \`${result.run_independence.work_dir}\`. The only shared artefact is the bare clone mirror in \`${result.run_independence.shared_immutable_clone_cache}\`, which is immutable and identity-verified per run.`)
    lines.push('')
    lines.push('| Target | Prepared worktree | HEAD | Clone cache | Graph artifact digest |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const target of result.run_independence.targets) {
      lines.push(`| \`${target.target_id}\` | \`${target.prepared_worktree}\` | \`${(target.head ?? '—').slice(0, 12)}\` | ${target.clone_cache_read} | \`${(target.graph_artifact_digest ?? '—').slice(0, 16)}\` |`)
    }
    lines.push('')
    lines.push('| Cell | Artifact digest | Channels observed |')
    lines.push('| --- | --- | --- |')
    for (const cell of [...result.run_independence.cells].sort((a, b) => a.cell_id.localeCompare(b.cell_id))) {
      lines.push(`| \`${cell.cell_id}\` | \`${cell.artifact_digest.slice(0, 16)}\` | ${cell.evidence_channels_observed} |`)
    }
  }
  lines.push('')
  lines.push('## Inherited #660 signal observation (read-only)')
  lines.push('')
  lines.push(result.inherited_signals.summary)
  lines.push('')
  lines.push('| Signal | Present in source | Co-occurring flag on cells | Measurably changed a cell? |')
  lines.push('| --- | --- | --- | --- |')
  for (const signal of result.inherited_signals.signals) {
    const present = signal.source_presence === null
      ? 'n/a (pattern, not a symbol)'
      : signal.source_presence.file_present
        ? (signal.source_presence.matches.length > 0 ? `yes: ${signal.source_presence.matches.join(', ')}` : 'no')
        : 'file absent'
    const cells = signal.co_occurring_flag_cells.length === 0
      ? 'none'
      : signal.co_occurring_flag_cells.map((entry) => entry.cell_id).join(', ')
    lines.push(`| ${signal.name} | ${present} | ${cells} | **no** (${signal.attribution_status}) |`)
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}
