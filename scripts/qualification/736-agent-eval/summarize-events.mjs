import { readFileSync, writeFileSync } from 'node:fs'

const input = process.argv[2]
const output = process.argv[3]
if (!input || !output) throw new Error('usage: node summarize-events.mjs <events.jsonl> <summary.json>')

const lines = readFileSync(input, 'utf8').split(/\r?\n/).filter((line) => line.trim().length > 0)
const summary = {
  schema_version: 1,
  command_calls: 0,
  mcp_calls: 0,
  mcp_calls_by_tool: {},
  web_searches: 0,
  file_changes: 0,
  errors: [],
  usage: null,
}

for (const line of lines) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    summary.errors.push('non-json event line')
    continue
  }
  if (event.type === 'turn.completed' && event.usage) summary.usage = event.usage
  if (event.type !== 'item.completed' || !event.item) continue
  const item = event.item
  if (item.type === 'command_execution') summary.command_calls += 1
  if (item.type === 'mcp_tool_call') {
    summary.mcp_calls += 1
    const key = `${item.server ?? 'unknown'}/${item.tool ?? 'unknown'}`
    summary.mcp_calls_by_tool[key] = (summary.mcp_calls_by_tool[key] ?? 0) + 1
    if (item.status === 'failed') summary.errors.push(`mcp failed: ${key}: ${item.error?.message ?? 'unknown error'}`)
  }
  if (item.type === 'web_search') summary.web_searches += 1
  if (item.type === 'file_change') summary.file_changes += 1
  if (item.type === 'error') summary.errors.push(item.message ?? 'agent error')
}

writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`)
