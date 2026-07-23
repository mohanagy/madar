import type { SkillInstallPlatform } from './install.js'

function shellBlock(platform: SkillInstallPlatform): string {
  if (platform === 'windows') {
    return `\`\`\`powershell
madar status
madar generate .
madar query "where is authentication implemented?"
\`\`\``
  }
  return `\`\`\`bash
madar status
madar generate .
madar query "where is authentication implemented?"
\`\`\``
}

/** Generate the small, platform-neutral skill installed with Madar. */
export function getBuiltInSkillContent(platform: SkillInstallPlatform): string {
  return `---
name: madar
description: query authenticated JavaScript and TypeScript repository evidence
trigger: /madar
---

# /madar

Madar builds a canonical JavaScript/TypeScript graph and exposes one retrieval operation.

## Workflow

1. Run \`madar status\`.
2. If the canonical index is missing, unavailable, or corrupt, run \`madar generate .\`.
3. For a repository question, call the Madar \`retrieve\` MCP tool exactly once with the user's question unchanged. If MCP is unavailable, run \`madar query "<question>"\`.
4. When \`outcome\` is \`evidence\`, answer from the authenticated excerpts and stored relationships.
5. Otherwise report the explicit boundary and perform only the focused verification needed to continue.
6. For code changes, verify edits with normal tests; graph evidence does not replace runtime verification.

${shellBlock(platform)}

## Safety

Enable project hooks and local MCP servers only in repositories you trust. Never invent nodes, relationships, paths, or coverage claims.
`
}
