/** Admission guidance shared by Codex integration and strict MCP initialization. */
export const SOURCE_RETRIEVAL_ADMISSION =
  'Read already located source directly when sufficient. Madar is optional; broad context discovery is experimental and may increase total tokens. Explicit user tool requirements take precedence.'

/** Discovery depends on the host surface; availability never requires use. */
export const SOURCE_RETRIEVAL_DISCOVERY =
  'When using Madar, call listed tools directly. For deferred tools, use the host tool catalog and its returned callable name; do not guess names. CLI commands need no tool discovery.'
