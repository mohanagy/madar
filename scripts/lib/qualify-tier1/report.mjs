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
    if (cell.measurement_limits?.length) {
      lines.push('- Measurement limits:')
      for (const limit of cell.measurement_limits) lines.push(`  - ${limit}`)
    }
    if (cell.evidence_reference) lines.push(`- Evidence: \`${cell.evidence_reference}\``)
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
