import { describe, expect, it } from 'vitest'

import { MCP_TOOLS } from '../../src/runtime/stdio/definitions.js'

const TOOL_LIST_BYTE_CEILING = 900

describe('MCP schema surface', () => {
  it('publishes one compact retrieve tool', () => {
    expect(MCP_TOOLS.map((tool) => tool.name)).toEqual(['retrieve'])
    expect(JSON.stringify({ tools: MCP_TOOLS }).length).toBeLessThanOrEqual(
      TOOL_LIST_BYTE_CEILING,
    )
  })

  it('accepts only question and optional budget', () => {
    expect(MCP_TOOLS[0]?.inputSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['question'],
      properties: {
        question: expect.objectContaining({
          type: 'string',
          minLength: 1,
        }),
        budget: expect.objectContaining({
          type: 'integer',
          minimum: 1,
        }),
      },
    })
  })
})
