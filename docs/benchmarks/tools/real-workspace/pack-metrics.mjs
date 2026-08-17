#!/usr/bin/env node
/*
 * Extracts the measured fields from one `madar pack` response, on stdin.
 *
 * The v1-era runner read `pack.token_count` with `?? 0`. That field is only
 * present on some retrieval paths -- a prompt answered through the other path
 * has no `pack.token_count` at all -- so the fallback filed a real response as
 * a zero-token measurement. Nothing distinguished that from a prompt that
 * genuinely packed nothing.
 *
 * `serialized_budget.token_count` is the size of the context actually
 * serialized and is present on every path, so it is the number this tool
 * records. A missing field is an error, never a zero.
 */

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { raw += chunk })
process.stdin.on('end', () => {
  let response
  try {
    response = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`pack did not return JSON: ${message}`)
    process.exit(1)
  }

  const tokenCount = response?.serialized_budget?.token_count
  if (typeof tokenCount !== 'number' || !Number.isFinite(tokenCount)) {
    console.error('pack response has no serialized_budget.token_count; refusing to record a zero')
    process.exit(1)
  }

  const matched = response?.pack?.matched_nodes
  if (!Array.isArray(matched)) {
    console.error('pack response has no pack.matched_nodes array; refusing to record a zero')
    process.exit(1)
  }

  console.log(JSON.stringify({
    serialized_token_count: tokenCount,
    matched_node_count: matched.length,
    top_labels: matched.slice(0, 5).map((node) => node?.label ?? null),
  }))
})
