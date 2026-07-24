import { MAX_RETRIEVE_BUDGET, MAX_RETRIEVE_QUESTION_LENGTH } from '../../domain/query/types.js'

export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    additionalProperties: false
    properties: Record<string, unknown>
    required: string[]
  }
}

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'retrieve',
    description:
      'Return the smallest deterministic evidence path for a TypeScript or JavaScript codebase question.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['question'],
      properties: {
        question: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_RETRIEVE_QUESTION_LENGTH,
          description: 'The codebase question to answer from authenticated graph evidence.',
        },
        budget: {
          type: 'integer',
          minimum: 1,
          description: `Requested result budget; effective serialized output is capped at ${MAX_RETRIEVE_BUDGET} tokens.`,
        },
      },
    },
  },
]
