import { describe, expect, it } from 'vitest'

import { activeMcpTools, MCP_TOOLS } from '../../src/runtime/stdio/definitions.js'

// #82 — pin the JSON byte size of the MCP tool list emitted on tools/list so a
// future tool addition or description regression can't silently re-inflate the
// cold-start cache_creation_input_tokens cost. Keep these numbers tight; if a
// new tool genuinely needs more bytes, raise the ceiling here in the same PR
// with a note in the commit message and the README.
//
// Post-#188 measurements (taken from `node -e "JSON.stringify({tools: ...})"`):
//   * Core profile (7 tools, the default):  ≈ 3,203 bytes  ≈ ~801 tokens
//   * Full profile (26 tools, opt-in):      ≈ 12,395 bytes ≈ ~3,099 tokens
//
// Pre-#82 core was 4,271 bytes / ~1,068 tokens — i.e. #82 cut the core profile
// by 30%. The ceilings below sit just above today's measurements to leave a
// small growth buffer without permitting a silent regression.

const CORE_PROFILE_BYTE_CEILING = 3_250
const FULL_PROFILE_BYTE_CEILING = 12_450  // v0.23: raised for the default-core graph_summary tool

function payloadBytes(tools: ReadonlyArray<unknown>): number {
  return JSON.stringify({ tools }).length
}

describe('MCP tool-schema byte budget (#82)', () => {
  it('the core profile JSON payload stays under the byte ceiling', () => {
    const bytes = payloadBytes(activeMcpTools('core'))
    expect(bytes, `core profile is ${bytes} bytes; ceiling is ${CORE_PROFILE_BYTE_CEILING}`).toBeLessThanOrEqual(CORE_PROFILE_BYTE_CEILING)
  })

  it('the full profile JSON payload stays under its byte ceiling', () => {
    const bytes = payloadBytes(activeMcpTools('full'))
    expect(bytes, `full profile is ${bytes} bytes; ceiling is ${FULL_PROFILE_BYTE_CEILING}`).toBeLessThanOrEqual(FULL_PROFILE_BYTE_CEILING)
  })

  it('the core profile contains exactly the documented 7 tools', () => {
    const core = activeMcpTools('core')
    expect(core.map((t) => t.name).sort()).toEqual([
      'call_chain',
      'community_overview',
      'graph_stats',
      'graph_summary',
      'impact',
      'pr_impact',
      'retrieve',
    ])
  })

  it('every core tool has a non-empty description (discoverability sanity check)', () => {
    for (const tool of activeMcpTools('core')) {
      expect(tool.description.length, `${tool.name} has empty description`).toBeGreaterThan(0)
    }
  })

  it('every full-profile tool has a non-empty description', () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.description.length, `${tool.name} has empty description`).toBeGreaterThan(0)
    }
  })
})
