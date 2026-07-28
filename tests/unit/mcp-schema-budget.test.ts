import { describe, expect, it } from 'vitest'

import { MCP_TOOLS } from '../../src/adapters/mcp/protocol.js'
import {
  MAX_RETRIEVE_BUDGET,
  MAX_RETRIEVE_QUESTION_LENGTH,
} from '../../src/domain/query/types.js'

const TOOL_LIST_BYTE_CEILING = 900

describe('MCP schema budget', () => {
  it('publishes one compact retrieve tool within the 900-byte ceiling', () => {
    expect(MCP_TOOLS.map((tool) => tool.name)).toEqual(['retrieve'])
    expect(Buffer.byteLength(JSON.stringify({ tools: MCP_TOOLS }), 'utf8'))
      .toBeLessThanOrEqual(TOOL_LIST_BYTE_CEILING)
  })

  it('accepts exactly required question and optional positive budget', () => {
    expect(MCP_TOOLS[0]?.inputSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['question'],
      properties: {
        question: expect.objectContaining({
          type: 'string',
          minLength: 1,
          maxLength: MAX_RETRIEVE_QUESTION_LENGTH,
        }),
        budget: expect.objectContaining({
          type: 'integer',
          minimum: 1,
        }),
      },
    })
    expect(MCP_TOOLS[0]?.inputSchema.properties.budget.description)
      .toContain(String(MAX_RETRIEVE_BUDGET))
    expect(Object.keys(MCP_TOOLS[0]?.inputSchema.properties ?? {}))
      .toEqual(['question', 'budget'])
  })

  it('seals the public schema against runtime mutation', () => {
    expect(Object.isFrozen(MCP_TOOLS)).toBe(true)
    expect(Object.isFrozen(MCP_TOOLS[0])).toBe(true)
    expect(Object.isFrozen(MCP_TOOLS[0]?.inputSchema)).toBe(true)
    expect(Object.isFrozen(MCP_TOOLS[0]?.inputSchema.properties)).toBe(true)
  })
})
