// Shared, directly testable pieces of the #736 paired-arm runner.
//
// Extracted from run-codex-arm.sh so CI can prove two things that shell-only
// syntax checks cannot: that Arm B actually receives the frozen madar_evidence
// server with a workable tool-approval policy, and that a refused MCP call
// fails the arm closed instead of being counted as delivered treatment.

const APPROVAL_REFUSAL = /requires approval|approval policy/i

export function renderArmConfig({ arm, runHome, madarRoot, workspace, model, effort }) {
  if (arm !== 'native' && arm !== 'madar') throw new Error(`unknown arm: ${arm}`)
  const base = `model = "${model}"
model_reasoning_effort = "${effort}"
web_search = "disabled"

[sandbox_workspace_write]
network_access = false

[shell_environment_policy]
inherit = "core"
set = { MADAR_736_EVAL = "1", HOME = "${runHome}/home", TMPDIR = "${runHome}/tmp", XDG_CONFIG_HOME = "${runHome}/xdg-config", XDG_CACHE_HOME = "${runHome}/xdg-cache" }
`
  if (arm === 'native') return base
  // Arm B differs only by the frozen read-only evidence server. The global
  // command approval policy stays `never`; this per-server policy is what makes
  // the already-frozen madar_evidence tools reachable under it.
  return `${base}
[mcp_servers.madar_evidence]
command = "node"
args = ["${madarRoot}/dist/src/cli/evidence-bin.js", "--root", "${workspace}"]
default_tools_approval_mode = "approve"
`
}

export function classifyMcpItem(item) {
  const status = String(item?.status ?? '')
  const message = String(item?.error?.message ?? '')
  if (status === 'completed' || status === 'succeeded' || status === 'success') {
    // A completed call whose payload truthfully reports unresolved/unsupported/
    // ambiguous/truncated is a product result, not a harness failure.
    return 'succeeded'
  }
  if (status === 'failed') return APPROVAL_REFUSAL.test(message) ? 'refused' : 'failed'
  return 'unknown'
}

export function summarizeEvents(lines) {
  const s = {
    schema_version: 2,
    command_calls: 0,
    mcp_calls: 0,
    mcp_calls_attempted: 0,
    mcp_calls_succeeded: 0,
    mcp_calls_failed: 0,
    mcp_calls_refused: 0,
    mcp_calls_unknown: 0,
    mcp_calls_by_tool: {},
    mcp_calls_by_tool_attempted: {},
    mcp_calls_by_tool_succeeded: {},
    mcp_calls_by_tool_failed: {},
    mcp_calls_by_tool_refused: {},
    mcp_servers_seen: [],
    web_searches: 0,
    file_changes: 0,
    errors: [],
    usage: null,
  }
  const servers = new Set()
  const bump = (bucket, key) => { s[bucket][key] = (s[bucket][key] ?? 0) + 1 }

  for (const line of lines) {
    let event
    try { event = JSON.parse(line) } catch { s.errors.push('non-json event line'); continue }
    if (event.type === 'turn.completed' && event.usage) s.usage = event.usage
    if (event.type !== 'item.completed' || !event.item) continue
    const item = event.item
    if (item.type === 'command_execution') s.command_calls += 1
    if (item.type === 'web_search') s.web_searches += 1
    if (item.type === 'file_change') s.file_changes += 1
    if (item.type === 'error') s.errors.push(item.message ?? 'agent error')
    if (item.type !== 'mcp_tool_call') continue

    const key = `${item.server ?? 'unknown'}/${item.tool ?? 'unknown'}`
    servers.add(item.server ?? 'unknown')
    const outcome = classifyMcpItem(item)
    s.mcp_calls_attempted += 1
    bump('mcp_calls_by_tool_attempted', key)
    if (outcome === 'succeeded') {
      s.mcp_calls_succeeded += 1
      bump('mcp_calls_by_tool_succeeded', key)
    } else if (outcome === 'refused') {
      s.mcp_calls_failed += 1
      s.mcp_calls_refused += 1
      bump('mcp_calls_by_tool_failed', key)
      bump('mcp_calls_by_tool_refused', key)
      s.errors.push(`mcp approval refused: ${key}: ${item.error?.message ?? 'unknown error'}`)
    } else if (outcome === 'failed') {
      s.mcp_calls_failed += 1
      bump('mcp_calls_by_tool_failed', key)
      s.errors.push(`mcp failed: ${key}: ${item.error?.message ?? 'unknown error'}`)
    } else {
      // Fail closed: an unclassifiable status is never counted as success.
      s.mcp_calls_unknown += 1
      s.mcp_calls_failed += 1
      bump('mcp_calls_by_tool_failed', key)
      s.errors.push(`mcp unclassifiable status: ${key}: ${item.status ?? 'missing'}`)
    }
  }
  // Back-compat: `mcp_calls` is retained and means ATTEMPTED calls.
  s.mcp_calls = s.mcp_calls_attempted
  s.mcp_calls_by_tool = { ...s.mcp_calls_by_tool_attempted }
  s.mcp_servers_seen = [...servers].sort()
  return s
}

export function treatmentDelivery({ arm, events }) {
  if (arm === 'native') return 'native_not_applicable'
  if (events.mcp_calls_attempted === 0) return 'madar_not_attempted'
  if (events.mcp_calls_refused > 0) return 'madar_blocked_by_approval'
  if (events.mcp_calls_succeeded > 0) return 'madar_delivered'
  return 'madar_operational_failure_only'
}

export function buildRunMeta({ taskId, arm, model, effort, rc, wallMs, before, after, events, finalExists, finalParses }) {
  const invalidReasons = []
  if (rc !== 0) invalidReasons.push(`codex_exit_${rc}`)
  if (before !== after) invalidReasons.push('workspace_mutated')
  if (events.file_changes > 0) invalidReasons.push('agent_file_change_event')
  if (events.web_searches > 0) invalidReasons.push('web_search_used')
  if (!finalExists) invalidReasons.push('missing_final_json')
  else if (!finalParses) invalidReasons.push('invalid_final_json')
  // Treatment-delivery integrity.
  if (events.mcp_calls_refused > 0) invalidReasons.push('mcp_approval_refused')
  if (events.mcp_calls_unknown > 0) invalidReasons.push('mcp_status_unclassifiable')
  if (arm === 'native' && events.mcp_calls_attempted > 0) invalidReasons.push('native_arm_mcp_contamination')

  return {
    schema_version: 2,
    task_id: taskId,
    arm,
    model,
    reasoning_effort: effort,
    codex_exit_code: rc,
    wall_ms: wallMs,
    workspace_digest_before: before,
    workspace_digest_after: after,
    command_calls: events.command_calls,
    mcp_calls: events.mcp_calls_attempted,
    mcp_calls_attempted: events.mcp_calls_attempted,
    mcp_calls_succeeded: events.mcp_calls_succeeded,
    mcp_calls_failed: events.mcp_calls_failed,
    mcp_calls_refused: events.mcp_calls_refused,
    mcp_calls_unknown: events.mcp_calls_unknown,
    mcp_calls_by_tool: events.mcp_calls_by_tool,
    mcp_calls_by_tool_attempted: events.mcp_calls_by_tool_attempted,
    mcp_calls_by_tool_succeeded: events.mcp_calls_by_tool_succeeded,
    mcp_calls_by_tool_failed: events.mcp_calls_by_tool_failed,
    mcp_calls_by_tool_refused: events.mcp_calls_by_tool_refused,
    mcp_servers_seen: events.mcp_servers_seen,
    web_searches: events.web_searches,
    file_changes: events.file_changes,
    usage: events.usage,
    event_errors: events.errors,
    // Treatment use is derived from SUCCESSFUL calls only, never from attempts.
    madar_mcp_used: events.mcp_calls_succeeded > 0,
    treatment_delivery: treatmentDelivery({ arm, events }),
    valid: invalidReasons.length === 0,
    invalid_reasons: invalidReasons,
  }
}

// ---- CLI ----------------------------------------------------------------
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync, existsSync, writeFileSync } = await import('node:fs')
  const [command, ...rest] = process.argv.slice(2)
  if (command === 'render-config') {
    const [arm, runHome, madarRoot, workspace, model, effort] = rest
    process.stdout.write(renderArmConfig({ arm, runHome, madarRoot, workspace, model, effort }))
  } else if (command === 'summarize-events') {
    const [input, output] = rest
    const lines = readFileSync(input, 'utf8').split(/\r?\n/).filter((l) => l.trim().length > 0)
    writeFileSync(output, `${JSON.stringify(summarizeEvents(lines), null, 2)}\n`)
  } else if (command === 'run-meta') {
    const [taskId, arm, model, effort, rcRaw, wallRaw, before, after, summaryPath, finalPath] = rest
    const events = JSON.parse(readFileSync(summaryPath, 'utf8'))
    const finalExists = existsSync(finalPath)
    let finalParses = false
    if (finalExists) { try { JSON.parse(readFileSync(finalPath, 'utf8')); finalParses = true } catch { finalParses = false } }
    const payload = buildRunMeta({
      taskId, arm, model, effort, rc: Number(rcRaw), wallMs: Number(wallRaw),
      before, after, events, finalExists, finalParses,
    })
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  } else {
    process.stderr.write('usage: arm-harness.mjs render-config|summarize-events|run-meta ...\n')
    process.exit(2)
  }
}
