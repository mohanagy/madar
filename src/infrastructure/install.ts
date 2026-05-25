import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { getBuiltInSkillContent } from './install-skill-templates.js'
import { buildPromptApplicabilityHookCommand } from '../runtime/task-applicability.js'
import {
  findPackageRoot as resolvePackageRoot,
  readPackageName as resolvePackageName,
  readPackageVersion as resolvePackageVersion,
} from '../shared/package-metadata.js'

export const SKILL_INSTALL_PLATFORMS = ['claude', 'gemini', 'codex', 'opencode', 'aider', 'claw', 'droid', 'trae', 'trae-cn', 'copilot', 'windows'] as const

export type SkillInstallPlatform = (typeof SKILL_INSTALL_PLATFORMS)[number]

export const INSTALL_PLATFORMS = [...SKILL_INSTALL_PLATFORMS, 'cursor'] as const

export type InstallPlatform = (typeof INSTALL_PLATFORMS)[number]

export const AGENT_PLATFORMS = ['codex', 'opencode', 'aider', 'claw', 'droid', 'trae', 'trae-cn'] as const

export type AgentPlatform = (typeof AGENT_PLATFORMS)[number]

export const MCP_TOOL_PROFILES = ['core', 'full'] as const

export type McpToolProfile = (typeof MCP_TOOL_PROFILES)[number]
export const INSTALL_PROFILES = [...MCP_TOOL_PROFILES, 'strict'] as const
export type InstallProfile = (typeof INSTALL_PROFILES)[number]

interface InstallPlatformConfig {
  skillFile: string
  skillDestination: string
  registerClaudeMd: boolean
}

interface InstallSkillOptions {
  homeDir?: string
  packageRoot?: string
  version?: string
}

interface McpInstallOptions {
  profile?: InstallProfile
}

type GeminiInstallOptions = InstallSkillOptions & McpInstallOptions

const SKILL_SLUG = 'madar'
const SKILL_COMMAND = '/madar'
const SECTION_MARKER = '## madar'
const HOME_SECTION_MARKER = '# madar'

const PLATFORM_CONFIG: Record<SkillInstallPlatform, InstallPlatformConfig> = {
  claude: {
    skillFile: 'skill.md',
    skillDestination: '.claude/skills/madar/SKILL.md',
    registerClaudeMd: true,
  },
  gemini: {
    skillFile: 'skill.md',
    skillDestination: '.gemini/skills/madar/SKILL.md',
    registerClaudeMd: false,
  },
  aider: {
    skillFile: 'skill-aider.md',
    skillDestination: '.aider/madar/SKILL.md',
    registerClaudeMd: false,
  },
  codex: {
    skillFile: 'skill-codex.md',
    skillDestination: '.agents/skills/madar/SKILL.md',
    registerClaudeMd: false,
  },
  copilot: {
    skillFile: 'skill-copilot.md',
    skillDestination: '.copilot/skills/madar/SKILL.md',
    registerClaudeMd: false,
  },
  opencode: {
    skillFile: 'skill-opencode.md',
    skillDestination: '.config/opencode/skills/madar/SKILL.md',
    registerClaudeMd: false,
  },
  claw: {
    skillFile: 'skill-claw.md',
    skillDestination: '.claw/skills/madar/SKILL.md',
    registerClaudeMd: false,
  },
  droid: {
    skillFile: 'skill-droid.md',
    skillDestination: '.factory/skills/madar/SKILL.md',
    registerClaudeMd: false,
  },
  trae: {
    skillFile: 'skill-trae.md',
    skillDestination: '.trae/skills/madar/SKILL.md',
    registerClaudeMd: false,
  },
  'trae-cn': {
    skillFile: 'skill-trae.md',
    skillDestination: '.trae-cn/skills/madar/SKILL.md',
    registerClaudeMd: false,
  },
  windows: {
    skillFile: 'skill-windows.md',
    skillDestination: '.claude/skills/madar/SKILL.md',
    registerClaudeMd: true,
  },
}

// Cross-platform hook: base64-encodes JSON payloads so the node -e command has
// zero special shell characters. Works on macOS, Linux, and Windows (PowerShell/CMD).
function hookCommand(payloadJson: string): string {
  const b64 = Buffer.from(payloadJson).toString('base64')
  return `node -e "try{require('fs').accessSync('out/graph.json');process.stdout.write(Buffer.from('${b64}','base64').toString())}catch(e){}"`
}

function hookCommandWithFallback(matchJson: string, missJson: string): string {
  const b64Match = Buffer.from(matchJson).toString('base64')
  const b64Miss = Buffer.from(missJson).toString('base64')
  return `node -e "var f;try{require('fs').accessSync('out/graph.json');f='${b64Match}'}catch(e){f='${b64Miss}'}process.stdout.write(Buffer.from(f,'base64').toString())"`
}

function decodeGeneratedHookPayloads(command: string): string[] {
  const decodedPayloads: string[] = []
  const seen = new Set<string>()
  const queue = [command]

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) {
      continue
    }

    for (const match of current.matchAll(/'([A-Za-z0-9+/=]{40,})'/g)) {
      const value = match[1]
      if (typeof value !== 'string' || seen.has(value)) {
        continue
      }

      seen.add(value)
      const decoded = Buffer.from(value, 'base64').toString('utf8')
      decodedPayloads.push(decoded)
      queue.push(decoded)
    }
  }

  return decodedPayloads
}

function hookCommandHasGraphCheck(command: string): boolean {
  return command.includes("accessSync('out/graph.json')")
    || decodeGeneratedHookPayloads(command).some((payload) => payload.includes("accessSync('out/graph.json')"))
}

function isMadarCodexHookPayload(payload: string): boolean {
  const hasCodexOutputShape = payload.includes('"systemMessage"') || payload.includes('"hookSpecificOutput"')
  const hasMadarGuidance =
    payload.includes('madar') ||
    payload.includes('context-pack-first') ||
    payload.includes('retrieve-first') ||
    payload.includes('knowledge graph')

  return hasCodexOutputShape && hasMadarGuidance
}

function isMadarCodexHookCommand(command: string): boolean {
  return (
    command.includes("accessSync('out/graph.json')") &&
    command.includes('process.stdout.write(Buffer.from(') &&
    decodeGeneratedHookPayloads(command).some(isMadarCodexHookPayload)
  )
}

function isMadarProjectHookPayload(payload: string): boolean {
  return payload.includes('"additionalContext"')
    && (payload.includes(RETRIEVE_FIRST_MESSAGE) || payload.includes(STRICT_CONTEXT_PACK_MESSAGE))
}

function isMadarProjectHookCommand(command: string): boolean {
  return (
    hookCommandHasGraphCheck(command) &&
    decodeGeneratedHookPayloads(command).some(isMadarProjectHookPayload)
  )
}

function isMadarProjectHook(hook: unknown, matcher?: string): boolean {
  if (!isRecord(hook) || !Array.isArray(hook.hooks)) {
    return false
  }

  if (matcher !== undefined && hook.matcher !== matcher) {
    return false
  }

  return hook.hooks.some(
    (entry) =>
      isRecord(entry) &&
      entry.type === 'command' &&
      typeof entry.command === 'string' &&
      isMadarProjectHookCommand(entry.command),
  )
}

function isMadarCodexHook(hook: unknown): boolean {
  if (!isRecord(hook) || hook.matcher !== 'Bash' || !Array.isArray(hook.hooks)) {
    return false
  }

  return hook.hooks.some(
    (entry) =>
      isRecord(entry) &&
      entry.type === 'command' &&
      typeof entry.command === 'string' &&
      isMadarCodexHookCommand(entry.command),
  )
}

const MCP_ROUTING_GUIDANCE =
  'Use the graph tool that matches the question: retrieve for direct codebase questions, relevant_files for where to open first, feature_map for the main areas and entry points, risk_map before editing, implementation_checklist for edit order and validation, and impact for blast radius.'

function strictContextPackStopRule(markdown: boolean): string {
  if (markdown) {
    return 'Answer after one high- or medium-confidence pack when `diagnostics.quality_score >= 0.5`, `missing_context` is empty, and diagnostics show no error-severity gaps.'
  }

  return 'answer after one high- or medium-confidence pack when diagnostics.quality_score >= 0.5, missing_context is empty, and diagnostics show no error-severity gaps'
}

function strictContextPackExpandRule(markdown: boolean): string {
  if (markdown) {
    return 'Only expand with `context_expand` or focused graph/search tools when `missing_context` / `missing_semantic` are non-empty, diagnostics show warn/error gaps, or the user asks for deeper verification.'
  }

  return 'expand only when missing_context / missing_semantic is non-empty, diagnostics show warn/error gaps, or the user asks for deeper verification'
}

const RETRIEVE_FIRST_MESSAGE =
  `STOP. This project has a madar knowledge graph. ${MCP_ROUTING_GUIDANCE} Madar answers most codebase questions in 1 focused MCP call instead of 5–10 sequential file reads (3x fewer turns, ~2.8x faster on a real production codebase). Do not use Glob, Grep, Bash, Read, or Agent tools first. Only fall back to raw file tools if the graph tools cannot answer the question or the MCP server is unavailable.`

const STRICT_CONTEXT_PACK_MESSAGE =
  `STOP. This project has a madar knowledge graph. Use strict compact MCP mode: call context_pack once for the task before broader exploration, ${strictContextPackStopRule(false)}, ${strictContextPackExpandRule(false)}, and avoid raw file search unless the pack is insufficient.`

const CODEX_CONTEXT_PACK_FIRST_MESSAGE =
  `STOP. This project has a madar knowledge graph. Follow the Codex context-pack-first workflow: run madar pack "<task or question>" --task explain before broad Bash search, raw file reads, or spawning workers. Use --task review, --task debug, or --task impact when that better matches the work. If MCP graph tools are available, use retrieve, relevant_files, feature_map, risk_map, implementation_checklist, or impact to refine the pack. Only fall back to raw file tools when the context pack or graph tools are missing, stale, or insufficient; read out/GRAPH_REPORT.md before expanding manually.`

const SETTINGS_HOOK = {
  // SECURITY: Keep this command static. Do not interpolate user-controlled input here.
  matcher: 'Glob|Grep|Bash|Agent|Read',
  hooks: [
    {
      type: 'command',
      command: hookCommand(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: RETRIEVE_FIRST_MESSAGE,
          },
        }),
      ),
    },
  ],
}

const CODEX_HOOK = {
  // SECURITY: Keep this command static. Do not interpolate user-controlled input here.
  hooks: {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [
          {
            type: 'command',
            command: hookCommand(
              JSON.stringify({
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: 'allow',
                },
                systemMessage: CODEX_CONTEXT_PACK_FIRST_MESSAGE,
              }),
            ),
          },
        ],
      },
    ],
  },
}

const GEMINI_HOOK = {
  // SECURITY: Keep this command static. Do not interpolate user-controlled input here.
  matcher: 'read_file|list_directory|search_for_pattern',
  hooks: [
    {
      type: 'command',
      command: hookCommandWithFallback(
        JSON.stringify({
          decision: 'allow',
          additionalContext: RETRIEVE_FIRST_MESSAGE,
        }),
        JSON.stringify({ decision: 'allow' }),
      ),
    },
  ],
}

const SKILL_REGISTRATION =
  `\n${HOME_SECTION_MARKER}\n` +
  `- **${SKILL_SLUG}** (\`~/.claude/skills/${SKILL_SLUG}/SKILL.md\`) - any input to knowledge graph. Trigger: \`${SKILL_COMMAND}\`\n` +
  `When the user types \`${SKILL_COMMAND}\`, invoke the Skill tool with \`skill: "${SKILL_SLUG}"\` before doing anything else.\n`

const CLAUDE_MD_SECTION = `${SECTION_MARKER}

IMPORTANT: This project has a madar knowledge graph. You MUST follow these rules:

1. **First decide whether the task needs local repository source-code context.** Only use madar when the task needs local repository source-code context. Skip madar for GitHub Projects board reviews, external URL/WebFetch-only tasks, \`gh auth\` / \`gh project\` setup, package-registry/security pages, and Product Hunt or marketing copy work.
2. **BEFORE answering a codebase question that needs local code context**, start with the graph tool that matches the question:
   - \`retrieve\` for "how does X work?" and other direct codebase questions
   - \`relevant_files\` for "which files should I open first?"
   - \`feature_map\` for "what parts of the codebase are involved?"
   - \`risk_map\` before editing to see likely hotspots
   - \`implementation_checklist\` for edit order and validation checkpoints
   - \`impact\` for "what breaks if I change X?"
3. **Do NOT use Glob, Grep, Bash, Read, or dispatch Agent/Explore subagents first** for codebase questions.
4. **Only fall back to raw file tools** if the graph tools cannot answer the question or the MCP server is unavailable. In that case, read out/GRAPH_REPORT.md first.
5. **Do NOT dispatch Explore or research agents** for codebase questions — the knowledge graph already has the structural context they would spend tokens discovering.
`

const STRICT_CLAUDE_MD_SECTION = `${SECTION_MARKER}

IMPORTANT: This project has a madar knowledge graph. You MUST follow these strict compact MCP rules:

1. **First decide whether the task needs local repository source-code context.** Only use madar when the task needs local repository source-code context. Skip madar for GitHub Projects board reviews, external URL/WebFetch-only tasks, \`gh auth\` / \`gh project\` setup, package-registry/security pages, and Product Hunt or marketing copy work.
2. **Call \`context_pack\` once for the task before broader exploration.**
3. **${strictContextPackStopRule(true)}**
4. **${strictContextPackExpandRule(true)}** Use \`context_expand\` first, then focused graph tools such as \`retrieve\`, \`relevant_files\`, \`feature_map\`, \`risk_map\`, \`implementation_checklist\`, or \`impact\`.
5. **Avoid raw file search unless the pack is insufficient.** If manual expansion is still required, read \`out/GRAPH_REPORT.md\` first.
`

const AGENTS_MD_SECTION = `${SECTION_MARKER}

IMPORTANT: This project has a madar knowledge graph. You MUST follow these rules:

1. **First decide whether the task needs local repository source-code context.** Only use madar when the task needs local repository source-code context. Skip madar for GitHub Projects board reviews, external URL/WebFetch-only tasks, \`gh auth\` / \`gh project\` setup, package-registry/security pages, and Product Hunt or marketing copy work.
2. **BEFORE answering a codebase question that needs local code context**, start with the graph tool that matches the question:
   - \`retrieve\` for "how does X work?" and other direct codebase questions
   - \`relevant_files\` for "which files should I open first?"
   - \`feature_map\` for "what parts of the codebase are involved?"
   - \`risk_map\` before editing to see likely hotspots
   - \`implementation_checklist\` for edit order and validation checkpoints
   - \`impact\` for "what breaks if I change X?"
3. **Do NOT search the codebase with other tools first** for codebase questions.
4. **Only fall back to raw file tools** if the graph tools cannot answer the question or the MCP server is unavailable. In that case, read out/GRAPH_REPORT.md first.
`

const AIDER_AGENTS_MD_SECTION = `${SECTION_MARKER}

### Aider profile

IMPORTANT: This project has a madar knowledge graph. Use a strict context-pack-first workflow:

1. **First decide whether the task needs local repository source-code context.** Only use madar when the task needs local repository source-code context. Skip madar for GitHub Projects board reviews, external URL/WebFetch-only tasks, \`gh auth\` / \`gh project\` setup, package-registry/security pages, and Product Hunt or marketing copy work.
2. **Before broad code search or manual file expansion**, compile a task-specific context pack:
   - \`madar pack "<task or question>" --task explain\`
   - use \`--task review\`, \`--task debug\`, or \`--task impact\` when that better matches the work
3. **Regenerate before expanding manually** when the pack is stale or missing:
   - run \`madar generate .\`
   - if you still need raw file reads, inspect \`out/GRAPH_REPORT.md\` first
4. **This profile writes AGENTS.md only.** Aider does not get an auto-installed MCP server or hook from this installer, so the AGENTS.md rule plus explicit \`madar pack\` calls are the enforcement mechanism.
5. **Uninstall behavior:** run \`madar aider uninstall\` to remove this AGENTS.md section while preserving unrelated content.

Manual verification:

\`\`\`bash
madar generate .
madar aider install
test -f AGENTS.md
madar pack "how does auth work?" --task explain
madar aider uninstall
\`\`\`
`

const CODEX_AGENTS_MD_SECTION = `${SECTION_MARKER}

### Codex CLI profile

IMPORTANT: This project has a madar knowledge graph. Use a strict context-pack-first workflow:

1. **First decide whether the task needs local repository source-code context.** Only use madar when the task needs local repository source-code context. Skip madar for GitHub Projects board reviews, external URL/WebFetch-only tasks, \`gh auth\` / \`gh project\` setup, package-registry/security pages, and Product Hunt or marketing copy work.
2. **Before broad code search, file reads, or worker dispatch**, compile a task-specific context pack:
   - \`madar pack "<task or question>" --task explain\`
   - use \`--task review\`, \`--task debug\`, or \`--task impact\` when that better matches the work
3. If MCP graph tools are available, use the focused tool that matches the question after the pack:
   - \`retrieve\` for direct codebase questions
   - \`relevant_files\` for where to open first
   - \`feature_map\` for involved areas and entry points
   - \`risk_map\` before editing
   - \`implementation_checklist\` for edit order and validation checkpoints
   - \`impact\` for blast radius
4. **Only fall back to raw file tools** when the context pack or graph tools are missing, stale, or insufficient. In that case, read \`out/GRAPH_REPORT.md\` first.
5. **Do not dispatch \`spawn_agent\` workers first** for codebase discovery. Let the context pack define likely entry files, risks, and missing context before parallel work.
6. **Uninstall behavior:** run \`madar codex uninstall\` to remove this AGENTS.md section and the madar Codex hook from \`.codex/hooks.json\` while preserving unrelated content.

Manual verification:

\`\`\`bash
madar generate .
madar codex install
test -f AGENTS.md && test -f .codex/hooks.json
madar codex uninstall
\`\`\`
`

const OPENCODE_AGENTS_MD_SECTION = `${SECTION_MARKER}

### OpenCode profile

IMPORTANT: This project has a madar knowledge graph. Use a strict context-pack-first workflow:

1. **First decide whether the task needs local repository source-code context.** Only use madar when the task needs local repository source-code context. Skip madar for GitHub Projects board reviews, external URL/WebFetch-only tasks, \`gh auth\` / \`gh project\` setup, package-registry/security pages, and Product Hunt or marketing copy work.
2. **Before broad code search, bash-heavy exploration, or worker dispatch**, compile a task-specific context pack:
   - \`madar pack "<task or question>" --task explain\`
   - use \`--task review\`, \`--task debug\`, or \`--task impact\` when that better matches the work
3. After the pack, use MCP graph tools when available inside OpenCode:
   - \`retrieve\` for direct codebase questions
   - \`relevant_files\` for where to open first
   - \`feature_map\` for involved areas and entry points
   - \`risk_map\` before editing
   - \`implementation_checklist\` for edit order and validation checkpoints
   - \`impact\` for blast radius
4. **Install artifacts:** this profile writes this AGENTS.md section, \`.opencode/plugins/madar.js\`, and the madar MCP server entry in \`opencode.json\` or \`opencode.jsonc\`.
5. **Only fall back to raw file tools** when the context pack or graph tools are missing, stale, or insufficient. In that case, read \`out/GRAPH_REPORT.md\` first.
6. **Uninstall behavior:** run \`madar opencode uninstall\` to remove the madar AGENTS.md section, plugin entry, plugin file, and madar MCP config while preserving unrelated content.

Manual verification:

\`\`\`bash
madar generate .
madar opencode install
test -f AGENTS.md && test -f .opencode/plugins/madar.js
test -f opencode.json || test -f opencode.jsonc
madar opencode uninstall
\`\`\`
`

const GEMINI_MD_SECTION = `${SECTION_MARKER}

IMPORTANT: This project has a madar knowledge graph. You MUST follow these rules:

1. **First decide whether the task needs local repository source-code context.** Only use madar when the task needs local repository source-code context. Skip madar for GitHub Projects board reviews, external URL/WebFetch-only tasks, \`gh auth\` / \`gh project\` setup, package-registry/security pages, and Product Hunt or marketing copy work.
2. **BEFORE answering a codebase question that needs local code context**, start with the graph tool that matches the question:
   - \`retrieve\` for "how does X work?" and other direct codebase questions
   - \`relevant_files\` for "which files should I open first?"
   - \`feature_map\` for "what parts of the codebase are involved?"
   - \`risk_map\` before editing to see likely hotspots
   - \`implementation_checklist\` for edit order and validation checkpoints
   - \`impact\` for "what breaks if I change X?"
3. **Do NOT search the codebase with other tools first** for codebase questions.
4. **Only fall back to raw file tools** if the graph tools cannot answer the question or the MCP server is unavailable. In that case, read out/GRAPH_REPORT.md first.
`

const STRICT_GEMINI_MD_SECTION = `${SECTION_MARKER}

IMPORTANT: This project has a madar knowledge graph. Use strict compact MCP guidance:

1. **First decide whether the task needs local repository source-code context.** Only use madar when the task needs local repository source-code context. Skip madar for GitHub Projects board reviews, external URL/WebFetch-only tasks, \`gh auth\` / \`gh project\` setup, package-registry/security pages, and Product Hunt or marketing copy work.
2. **Call \`context_pack\` once for the task before broader exploration.**
3. **${strictContextPackStopRule(true)}**
4. **${strictContextPackExpandRule(true)}** Use \`context_expand\` first, then focused graph tools such as \`retrieve\`, \`relevant_files\`, \`feature_map\`, \`risk_map\`, \`implementation_checklist\`, or \`impact\`.
5. **Avoid raw file search unless the pack is insufficient.** If manual expansion is still required, read \`out/GRAPH_REPORT.md\` first.
`

const SKILL_REGISTRATION_MARKER = '- **madar**'
const LOCAL_SKILL_ASSET_DIRECTORY = join('assets', 'skills')
const PRIMARY_CLI_BIN_NAME = 'madar'
const CLI_BIN_NAMES = [PRIMARY_CLI_BIN_NAME] as const
const OPENCODE_PLUGIN_RELATIVE_PATH = '.opencode/plugins/madar.js'
const OPENCODE_JSON_CONFIG_PATH = 'opencode.json'
const OPENCODE_JSONC_CONFIG_PATH = 'opencode.jsonc'
const OPENCODE_MCP_SERVER_NAME = 'madar'
const CURSOR_RULE_RELATIVE_PATH = '.cursor/rules/madar.mdc'
const OPENCODE_PLUGIN_JS = `// madar OpenCode plugin
// Injects a knowledge graph reminder before bash tool calls when the graph exists.
import { existsSync } from "fs";
import { join } from "path";

export const MadarPlugin = async ({ directory }) => {
  let reminded = false;

  return {
    "tool.execute.before": async (input, output) => {
      if (reminded) return;
      if (!existsSync(join(directory, "out", "graph.json"))) return;

      if (input.tool === "bash") {
          output.args.command =
            'echo "[madar] Knowledge graph available. Use the graph tool that matches the question: retrieve, relevant_files, feature_map, risk_map, implementation_checklist, or impact. Read out/GRAPH_REPORT.md before raw file search if needed." && ' +
            output.args.command;
        reminded = true;
      }
    },
  };
};
`

const CURSOR_RULE = `---
description: madar knowledge graph — MUST use madar MCP tools before searching files
alwaysApply: true
---

IMPORTANT: This project has a madar knowledge graph.

1. **First decide whether the task needs local repository source-code context.** Only use madar when the task needs local repository source-code context. Skip madar for GitHub Projects board reviews, external URL/WebFetch-only tasks, \`gh auth\` / \`gh project\` setup, package-registry/security pages, and Product Hunt or marketing copy work.
2. **BEFORE answering a codebase question that needs local code context**, start with the graph tool that matches the question:
   - \`retrieve\` for "how does X work?" and other direct codebase questions
   - \`relevant_files\` for "which files should I open first?"
   - \`feature_map\` for "what parts of the codebase are involved?"
   - \`risk_map\` before editing to see likely hotspots
   - \`implementation_checklist\` for edit order and validation checkpoints
   - \`impact\` for "what breaks if I change X?"
3. **Do NOT search the codebase with other tools first** for codebase questions.
4. **Only fall back to raw file tools** if the graph tools cannot answer the question or the MCP server is unavailable. In that case, read out/GRAPH_REPORT.md first.
`

const STRICT_CURSOR_RULE = `---
description: madar strict compact MCP mode — use one context pack before broader exploration
alwaysApply: true
---

IMPORTANT: This project has a madar knowledge graph. Use strict compact MCP guidance:

1. **First decide whether the task needs local repository source-code context.** Only use madar when the task needs local repository source-code context. Skip madar for GitHub Projects board reviews, external URL/WebFetch-only tasks, \`gh auth\` / \`gh project\` setup, package-registry/security pages, and Product Hunt or marketing copy work.
2. **Call \`context_pack\` once for the task before broader exploration.**
3. **${strictContextPackStopRule(true)}**
4. **${strictContextPackExpandRule(true)}** Use \`context_expand\` first, then focused graph tools such as \`retrieve\`, \`relevant_files\`, \`feature_map\`, \`risk_map\`, \`implementation_checklist\`, or \`impact\`.
5. **Avoid raw file search unless the pack is insufficient.** If manual expansion is still required, read \`out/GRAPH_REPORT.md\` first.
`

function claudeMdSection(profile?: InstallProfile): string {
  return profile === 'strict' ? STRICT_CLAUDE_MD_SECTION : CLAUDE_MD_SECTION
}

function geminiMdSection(profile?: InstallProfile): string {
  return profile === 'strict' ? STRICT_GEMINI_MD_SECTION : GEMINI_MD_SECTION
}

function cursorRule(profile?: InstallProfile): string {
  return profile === 'strict' ? STRICT_CURSOR_RULE : CURSOR_RULE
}

function settingsHook(profile?: InstallProfile): Record<string, unknown> {
  return {
    hooks: [
      {
        type: 'command',
        command: buildPromptApplicabilityHookCommand(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'UserPromptSubmit',
              additionalContext: profile === 'strict' ? STRICT_CONTEXT_PACK_MESSAGE : RETRIEVE_FIRST_MESSAGE,
            },
          }),
          'UserPromptSubmit',
        ),
      },
    ],
  }
}

function geminiHook(profile?: InstallProfile): Record<string, unknown> {
  return {
    matcher: 'read_file|list_directory|search_for_pattern',
    hooks: [
      {
        type: 'command',
        command: hookCommandWithFallback(
          JSON.stringify({
            decision: 'allow',
            additionalContext: profile === 'strict' ? STRICT_CONTEXT_PACK_MESSAGE : RETRIEVE_FIRST_MESSAGE,
          }),
          JSON.stringify({ decision: 'allow' }),
        ),
      },
    ],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ensureParentDirectory(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
}

function readJsonObject(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) {
    return {}
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    if (!isRecord(parsed)) {
      throw new Error(`Failed to parse ${filePath}: expected a JSON object at the top level.`)
    }
    return parsed
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Failed to parse')) {
      throw error
    }
    throw new Error(`Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function stripJsonc(content: string): string {
  let output = ''
  let inString = false
  let escaped = false

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]
    const nextCharacter = content[index + 1]

    if (inString) {
      output += character
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }

    if (character === '"') {
      inString = true
      output += character
      continue
    }

    if (character === '/' && nextCharacter === '/') {
      while (index < content.length && content[index] !== '\n') {
        index += 1
      }
      output += '\n'
      continue
    }

    if (character === '/' && nextCharacter === '*') {
      index += 2
      while (index < content.length && !(content[index] === '*' && content[index + 1] === '/')) {
        output += content[index] === '\n' ? '\n' : ' '
        index += 1
      }
      index += 1
      continue
    }

    output += character
  }

  return output
}

function removeTrailingCommas(content: string): string {
  let output = ''
  let inString = false
  let escaped = false

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]

    if (inString) {
      output += character
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }

    if (character === '"') {
      inString = true
      output += character
      continue
    }

    if (character === ',') {
      let lookahead = index + 1
      while (lookahead < content.length && /\s/.test(content[lookahead] ?? '')) {
        lookahead += 1
      }
      if (content[lookahead] === '}' || content[lookahead] === ']') {
        continue
      }
    }

    output += character
  }

  return output
}

function readJsoncObject(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) {
    return {}
  }

  try {
    const content = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(removeTrailingCommas(stripJsonc(content)))
    if (!isRecord(parsed)) {
      throw new Error(`Failed to parse ${filePath}: expected a JSON object at the top level.`)
    }
    return parsed
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Failed to parse')) {
      throw error
    }
    throw new Error(`Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function writeJson(filePath: string, value: Record<string, unknown>): void {
  ensureParentDirectory(filePath)
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function resolveOpencodeConfigPath(projectDir: string): string {
  const jsonPath = join(projectDir, OPENCODE_JSON_CONFIG_PATH)
  if (existsSync(jsonPath)) {
    return jsonPath
  }

  const jsoncPath = join(projectDir, OPENCODE_JSONC_CONFIG_PATH)
  if (existsSync(jsoncPath)) {
    return jsoncPath
  }

  return jsonPath
}

function readOpencodeConfig(filePath: string): Record<string, unknown> {
  return filePath.endsWith('.jsonc') ? readJsoncObject(filePath) : readJsonObject(filePath)
}

interface JsoncPropertyRange {
  key: string
  propertyStart: number
  valueStart: number
  valueEnd: number
  commaStart: number | undefined
  commaEnd: number | undefined
}

interface JsoncObjectRange {
  start: number
  end: number
  properties: JsoncPropertyRange[]
}

interface JsoncArrayElementRange {
  value: unknown
  elementStart: number
  valueStart: number
  valueEnd: number
  commaStart: number | undefined
  commaEnd: number | undefined
}

interface JsoncArrayRange {
  start: number
  end: number
  elements: JsoncArrayElementRange[]
}

function isJsoncConfigPath(filePath: string): boolean {
  return filePath.endsWith('.jsonc')
}

function skipJsoncWhitespaceAndComments(content: string, start: number, end = content.length): number {
  let index = start
  while (index < end) {
    const character = content[index]
    const nextCharacter = content[index + 1]

    if (/\s/.test(character ?? '')) {
      index += 1
      continue
    }

    if (character === '/' && nextCharacter === '/') {
      index += 2
      while (index < end && content[index] !== '\n') {
        index += 1
      }
      continue
    }

    if (character === '/' && nextCharacter === '*') {
      index += 2
      while (index < end && !(content[index] === '*' && content[index + 1] === '/')) {
        index += 1
      }
      index = Math.min(index + 2, end)
      continue
    }

    break
  }
  return index
}

function readJsoncStringEnd(content: string, start: number): number {
  if (content[start] !== '"') {
    throw new Error('Expected JSON string')
  }

  let escaped = false
  for (let index = start + 1; index < content.length; index += 1) {
    const character = content[index]
    if (escaped) {
      escaped = false
    } else if (character === '\\') {
      escaped = true
    } else if (character === '"') {
      return index + 1
    }
  }

  throw new Error('Unterminated JSON string')
}

function readJsoncString(content: string, start: number): { value: string; end: number } {
  const end = readJsoncStringEnd(content, start)
  const value = JSON.parse(content.slice(start, end)) as unknown
  if (typeof value !== 'string') {
    throw new Error('Expected JSON string')
  }
  return { value, end }
}

function skipJsoncComment(content: string, start: number): number {
  const nextCharacter = content[start + 1]
  if (content[start] === '/' && nextCharacter === '/') {
    let index = start + 2
    while (index < content.length && content[index] !== '\n') {
      index += 1
    }
    return index
  }

  if (content[start] === '/' && nextCharacter === '*') {
    let index = start + 2
    while (index < content.length && !(content[index] === '*' && content[index + 1] === '/')) {
      index += 1
    }
    return Math.min(index + 2, content.length)
  }

  return start
}

function findMatchingJsoncBracket(content: string, start: number, open: string, close: string): number {
  let depth = 0
  for (let index = start; index < content.length; index += 1) {
    const character = content[index]

    if (character === '"') {
      index = readJsoncStringEnd(content, index) - 1
      continue
    }

    if (character === '/' && (content[index + 1] === '/' || content[index + 1] === '*')) {
      index = skipJsoncComment(content, index) - 1
      continue
    }

    if (character === open) {
      depth += 1
    } else if (character === close) {
      depth -= 1
      if (depth === 0) {
        return index
      }
    }
  }

  throw new Error(`Unterminated JSONC ${open}${close} block`)
}

function readJsoncValueEnd(content: string, start: number): number {
  const valueStart = skipJsoncWhitespaceAndComments(content, start)
  const character = content[valueStart]

  if (character === '{') {
    return findMatchingJsoncBracket(content, valueStart, '{', '}') + 1
  }
  if (character === '[') {
    return findMatchingJsoncBracket(content, valueStart, '[', ']') + 1
  }
  if (character === '"') {
    return readJsoncStringEnd(content, valueStart)
  }

  let index = valueStart
  while (index < content.length) {
    const current = content[index]
    if (current === ',' || current === '}' || current === ']' || (current === '/' && (content[index + 1] === '/' || content[index + 1] === '*'))) {
      break
    }
    index += 1
  }

  return index
}

function readJsoncObjectRange(content: string, start: number): JsoncObjectRange {
  const objectStart = skipJsoncWhitespaceAndComments(content, start)
  if (content[objectStart] !== '{') {
    throw new Error('Expected JSONC object')
  }

  const objectEnd = findMatchingJsoncBracket(content, objectStart, '{', '}')
  const properties: JsoncPropertyRange[] = []
  let index = objectStart + 1

  while (index < objectEnd) {
    index = skipJsoncWhitespaceAndComments(content, index, objectEnd)
    if (index >= objectEnd || content[index] === '}') {
      break
    }
    if (content[index] === ',') {
      index += 1
      continue
    }

    const propertyStart = index
    const key = readJsoncString(content, index)
    index = skipJsoncWhitespaceAndComments(content, key.end, objectEnd)
    if (content[index] !== ':') {
      throw new Error('Expected JSONC property separator')
    }

    const valueStart = skipJsoncWhitespaceAndComments(content, index + 1, objectEnd)
    const valueEnd = readJsoncValueEnd(content, valueStart)
    index = skipJsoncWhitespaceAndComments(content, valueEnd, objectEnd)

    let commaStart: number | undefined
    let commaEnd: number | undefined
    if (content[index] === ',') {
      commaStart = index
      commaEnd = index + 1
      index = commaEnd
    }

    properties.push({ key: key.value, propertyStart, valueStart, valueEnd, commaStart, commaEnd })
  }

  return { start: objectStart, end: objectEnd, properties }
}

function readRootJsoncObject(content: string): JsoncObjectRange {
  return readJsoncObjectRange(content, 0)
}

function readJsoncArrayRange(content: string, start: number): JsoncArrayRange {
  const arrayStart = skipJsoncWhitespaceAndComments(content, start)
  if (content[arrayStart] !== '[') {
    throw new Error('Expected JSONC array')
  }

  const arrayEnd = findMatchingJsoncBracket(content, arrayStart, '[', ']')
  const elements: JsoncArrayElementRange[] = []
  let index = arrayStart + 1

  while (index < arrayEnd) {
    index = skipJsoncWhitespaceAndComments(content, index, arrayEnd)
    if (index >= arrayEnd || content[index] === ']') {
      break
    }
    if (content[index] === ',') {
      index += 1
      continue
    }

    const elementStart = index
    const valueStart = index
    const valueEnd = readJsoncValueEnd(content, valueStart)
    let value: unknown
    try {
      value = JSON.parse(removeTrailingCommas(stripJsonc(content.slice(valueStart, valueEnd))))
    } catch {
      value = undefined
    }

    index = skipJsoncWhitespaceAndComments(content, valueEnd, arrayEnd)
    let commaStart: number | undefined
    let commaEnd: number | undefined
    if (content[index] === ',') {
      commaStart = index
      commaEnd = index + 1
      index = commaEnd
    }

    elements.push({ value, elementStart, valueStart, valueEnd, commaStart, commaEnd })
  }

  return { start: arrayStart, end: arrayEnd, elements }
}

function lineIndentAt(content: string, index: number): string {
  const lineStart = content.lastIndexOf('\n', Math.max(index - 1, 0)) + 1
  let cursor = lineStart
  while (cursor < content.length && (content[cursor] === ' ' || content[cursor] === '\t')) {
    cursor += 1
  }
  return content.slice(lineStart, cursor)
}

function rangeUsesNewlines(content: string, range: { start: number; end: number }): boolean {
  return content.slice(range.start, range.end).includes('\n')
}

function closeLineInsertPosition(content: string, range: { start: number; end: number }): number {
  const lineStart = content.lastIndexOf('\n', range.end - 1)
  return lineStart > range.start ? lineStart + 1 : range.end
}

function stringifyJsoncValue(value: unknown, indent: string): string {
  const serialized = JSON.stringify(value, null, 2)
  if (serialized === undefined) {
    throw new Error('Cannot write undefined JSONC value')
  }
  return serialized.replace(/\n/g, `\n${indent}`)
}

function findJsoncProperty(object: JsoncObjectRange, key: string): JsoncPropertyRange | undefined {
  return object.properties.find((property) => property.key === key)
}

function objectChildIndent(content: string, object: JsoncObjectRange): string {
  const firstProperty = object.properties[0]
  return firstProperty ? lineIndentAt(content, firstProperty.propertyStart) : `${lineIndentAt(content, object.start)}  `
}

function arrayChildIndent(content: string, array: JsoncArrayRange): string {
  const firstElement = array.elements[0]
  return firstElement ? lineIndentAt(content, firstElement.elementStart) : `${lineIndentAt(content, array.start)}  `
}

function setJsoncObjectProperty(content: string, object: JsoncObjectRange, key: string, value: unknown): string {
  const existingProperty = findJsoncProperty(object, key)
  if (existingProperty) {
    const propertyIndent = lineIndentAt(content, existingProperty.propertyStart)
    const serializedValue = stringifyJsoncValue(value, propertyIndent)
    return `${content.slice(0, existingProperty.valueStart)}${serializedValue}${content.slice(existingProperty.valueEnd)}`
  }

  const propertyIndent = objectChildIndent(content, object)
  const propertyText = `${JSON.stringify(key)}: ${stringifyJsoncValue(value, propertyIndent)}`
  const multiline = rangeUsesNewlines(content, object)

  if (object.properties.length === 0) {
    if (!multiline) {
      return `${content.slice(0, object.start + 1)}${propertyText}${content.slice(object.end)}`
    }

    const insertPosition = closeLineInsertPosition(content, object)
    return `${content.slice(0, insertPosition)}${propertyIndent}${propertyText}\n${content.slice(insertPosition)}`
  }

  const lastProperty = object.properties[object.properties.length - 1]!
  if (!multiline) {
    const insertion = lastProperty.commaStart !== undefined ? ` ${propertyText},` : `, ${propertyText}`
    const insertPosition = lastProperty.commaStart !== undefined ? object.end : lastProperty.valueEnd
    return `${content.slice(0, insertPosition)}${insertion}${content.slice(insertPosition)}`
  }

  const insertPosition = closeLineInsertPosition(content, object)
  if (lastProperty.commaStart !== undefined) {
    return `${content.slice(0, insertPosition)}${propertyIndent}${propertyText},\n${content.slice(insertPosition)}`
  }

  const withComma = `${content.slice(0, lastProperty.valueEnd)},${content.slice(lastProperty.valueEnd)}`
  const shiftedInsertPosition = insertPosition > lastProperty.valueEnd ? insertPosition + 1 : insertPosition
  return `${withComma.slice(0, shiftedInsertPosition)}${propertyIndent}${propertyText}\n${withComma.slice(shiftedInsertPosition)}`
}

function deleteJsoncObjectProperty(content: string, object: JsoncObjectRange, key: string): string {
  const propertyIndex = object.properties.findIndex((property) => property.key === key)
  if (propertyIndex === -1) {
    return content
  }

  const property = object.properties[propertyIndex]!
  if (property.commaEnd !== undefined) {
    return `${content.slice(0, property.propertyStart)}${content.slice(property.commaEnd)}`
  }

  if (propertyIndex > 0) {
    const previousProperty = object.properties[propertyIndex - 1]!
    const deleteStart = previousProperty.commaStart ?? previousProperty.valueEnd
    return `${content.slice(0, deleteStart)}${content.slice(property.valueEnd)}`
  }

  return `${content.slice(0, property.propertyStart)}${content.slice(property.valueEnd)}`
}

function insertJsoncStringArrayElement(content: string, array: JsoncArrayRange, value: string): string {
  const serializedValue = JSON.stringify(value)
  const multiline = rangeUsesNewlines(content, array)
  const elementIndent = arrayChildIndent(content, array)

  if (array.elements.length === 0) {
    if (!multiline) {
      return `${content.slice(0, array.start + 1)}${serializedValue}${content.slice(array.end)}`
    }

    const insertPosition = closeLineInsertPosition(content, array)
    return `${content.slice(0, insertPosition)}${elementIndent}${serializedValue}\n${content.slice(insertPosition)}`
  }

  const lastElement = array.elements[array.elements.length - 1]!
  if (!multiline) {
    const insertion = lastElement.commaStart !== undefined ? ` ${serializedValue},` : `, ${serializedValue}`
    const insertPosition = lastElement.commaStart !== undefined ? array.end : lastElement.valueEnd
    return `${content.slice(0, insertPosition)}${insertion}${content.slice(insertPosition)}`
  }

  const insertPosition = closeLineInsertPosition(content, array)
  if (lastElement.commaStart !== undefined) {
    return `${content.slice(0, insertPosition)}${elementIndent}${serializedValue},\n${content.slice(insertPosition)}`
  }

  const withComma = `${content.slice(0, lastElement.valueEnd)},${content.slice(lastElement.valueEnd)}`
  const shiftedInsertPosition = insertPosition > lastElement.valueEnd ? insertPosition + 1 : insertPosition
  return `${withComma.slice(0, shiftedInsertPosition)}${elementIndent}${serializedValue}\n${withComma.slice(shiftedInsertPosition)}`
}

function deleteJsoncStringArrayElement(content: string, array: JsoncArrayRange, value: string): string {
  const elementIndex = array.elements.findIndex((element) => element.value === value)
  if (elementIndex === -1) {
    return content
  }

  const element = array.elements[elementIndex]!
  if (element.commaEnd !== undefined) {
    return `${content.slice(0, element.elementStart)}${content.slice(element.commaEnd)}`
  }

  if (elementIndex > 0) {
    const previousElement = array.elements[elementIndex - 1]!
    const deleteStart = previousElement.commaStart ?? previousElement.valueEnd
    return `${content.slice(0, deleteStart)}${content.slice(element.valueEnd)}`
  }

  return `${content.slice(0, element.elementStart)}${content.slice(element.valueEnd)}`
}

function writeOpencodePluginRegistration(configPath: string, config: Record<string, unknown>, pluginWasArray: boolean): void {
  if (!isJsoncConfigPath(configPath) || !existsSync(configPath)) {
    writeJson(configPath, config)
    return
  }

  const content = readFileSync(configPath, 'utf8')
  const root = readRootJsoncObject(content)
  const pluginProperty = findJsoncProperty(root, 'plugin')
  const pluginValueStart = pluginProperty ? skipJsoncWhitespaceAndComments(content, pluginProperty.valueStart) : -1
  const updated = pluginWasArray && pluginProperty && content[pluginValueStart] === '['
    ? insertJsoncStringArrayElement(content, readJsoncArrayRange(content, pluginValueStart), OPENCODE_PLUGIN_RELATIVE_PATH)
    : setJsoncObjectProperty(content, root, 'plugin', config.plugin)

  ensureParentDirectory(configPath)
  writeFileSync(configPath, updated, 'utf8')
}

function writeOpencodePluginDeregistration(configPath: string, config: Record<string, unknown>): void {
  if (!isJsoncConfigPath(configPath) || !existsSync(configPath)) {
    writeJson(configPath, config)
    return
  }

  const content = readFileSync(configPath, 'utf8')
  const root = readRootJsoncObject(content)
  const pluginProperty = findJsoncProperty(root, 'plugin')
  if (!pluginProperty) {
    return
  }

  const pluginValueStart = skipJsoncWhitespaceAndComments(content, pluginProperty.valueStart)
  const updated = Object.hasOwn(config, 'plugin') && content[pluginValueStart] === '['
    ? deleteJsoncStringArrayElement(content, readJsoncArrayRange(content, pluginValueStart), OPENCODE_PLUGIN_RELATIVE_PATH)
    : deleteJsoncObjectProperty(content, root, 'plugin')

  writeFileSync(configPath, updated, 'utf8')
}

function writeOpencodeMcpServerConfig(configPath: string, config: Record<string, unknown>, mcpWasRecord: boolean): void {
  if (!isJsoncConfigPath(configPath) || !existsSync(configPath)) {
    writeJson(configPath, config)
    return
  }

  const mcpConfig = config.mcp
  if (!isRecord(mcpConfig)) {
    writeJson(configPath, config)
    return
  }

  const serverConfig = mcpConfig[OPENCODE_MCP_SERVER_NAME]
  const content = readFileSync(configPath, 'utf8')
  const root = readRootJsoncObject(content)
  const mcpProperty = findJsoncProperty(root, 'mcp')
  const mcpValueStart = mcpProperty ? skipJsoncWhitespaceAndComments(content, mcpProperty.valueStart) : -1
  const updated = mcpWasRecord && mcpProperty && content[mcpValueStart] === '{'
    ? setJsoncObjectProperty(content, readJsoncObjectRange(content, mcpValueStart), OPENCODE_MCP_SERVER_NAME, serverConfig)
    : setJsoncObjectProperty(content, root, 'mcp', mcpConfig)

  ensureParentDirectory(configPath)
  writeFileSync(configPath, updated, 'utf8')
}

function writeOpencodeMcpRemovalConfig(configPath: string, config: Record<string, unknown>): void {
  if (!isJsoncConfigPath(configPath) || !existsSync(configPath)) {
    writeJson(configPath, config)
    return
  }

  const content = readFileSync(configPath, 'utf8')
  const root = readRootJsoncObject(content)
  const mcpProperty = findJsoncProperty(root, 'mcp')
  if (!mcpProperty) {
    return
  }

  if (!isRecord(config.mcp)) {
    writeFileSync(configPath, deleteJsoncObjectProperty(content, root, 'mcp'), 'utf8')
    return
  }

  const mcpValueStart = skipJsoncWhitespaceAndComments(content, mcpProperty.valueStart)
  const updated = content[mcpValueStart] === '{'
    ? deleteJsoncObjectProperty(content, readJsoncObjectRange(content, mcpValueStart), OPENCODE_MCP_SERVER_NAME)
    : setJsoncObjectProperty(content, root, 'mcp', config.mcp)

  writeFileSync(configPath, updated, 'utf8')
}

function opencodeConfigDisplayPath(configPath: string): string {
  return basename(configPath)
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key]
  if (isRecord(existing)) {
    return existing
  }
  const next: Record<string, unknown> = {}
  parent[key] = next
  return next
}

function ensureArray(parent: Record<string, unknown>, key: string): unknown[] {
  const existing = parent[key]
  if (Array.isArray(existing)) {
    return existing
  }
  const next: unknown[] = []
  parent[key] = next
  return next
}

function sectionFileDisplayName(targetPath: string): string {
  const fileName = basename(targetPath)
  if (fileName === 'CLAUDE.md' || fileName === 'GEMINI.md' || fileName === 'AGENTS.md') {
    return fileName
  }
  return 'AGENTS.md'
}

function removeMarkdownSection(content: string, marker: string, nextHeadingPrefix: string): string {
  const startIndex = content.indexOf(marker)
  if (startIndex === -1) {
    return content.trimEnd()
  }

  const nextHeadingIndex = content.indexOf(`\n${nextHeadingPrefix}`, startIndex + marker.length)
  const before = content.slice(0, startIndex).trimEnd()
  const after = nextHeadingIndex === -1 ? '' : content.slice(nextHeadingIndex + 1).trimStart()

  if (before.length > 0 && after.length > 0) {
    return `${before}\n\n${after}`.trimEnd()
  }

  return `${before}${after}`.trimEnd()
}

function removeSection(content: string): string {
  return removeMarkdownSection(content, SECTION_MARKER, '## ')
}

function removeHomeSkillRegistration(content: string): string {
  return removeMarkdownSection(content, HOME_SECTION_MARKER, '# ')
}

function removeInstalledSkill(destinationPath: string, stopDirectory: string, label = 'skill removed'): string | undefined {
  if (!existsSync(destinationPath)) {
    return undefined
  }

  unlinkSync(destinationPath)
  const versionPath = join(dirname(destinationPath), '.madar_version')
  if (existsSync(versionPath)) {
    unlinkSync(versionPath)
  }

  removeEmptyDirectories(dirname(destinationPath), stopDirectory)
  return `${label} -> ${destinationPath}`
}

function findPackageRoot(startDirectory?: string): string {
  return resolvePackageRoot(startDirectory)
}

function formatPlatformDisplayName(platform: AgentPlatform): string {
  if (platform === 'codex') {
    return 'Codex'
  }
  if (platform === 'opencode') {
    return 'OpenCode'
  }
  if (platform === 'aider') {
    return 'Aider'
  }
  if (platform === 'claw') {
    return 'OpenClaw'
  }
  if (platform === 'droid') {
    return 'Factory Droid'
  }
  if (platform === 'trae') {
    return 'Trae'
  }
  return 'Trae CN'
}

function removeEmptyDirectories(startDirectory: string, stopDirectory: string): void {
  let currentDirectory = resolve(startDirectory)
  const resolvedStopDirectory = resolve(stopDirectory)

  while (currentDirectory.startsWith(`${resolvedStopDirectory}/`) || currentDirectory === resolvedStopDirectory) {
    if (currentDirectory === resolvedStopDirectory) {
      break
    }

    try {
      rmdirSync(currentDirectory)
    } catch {
      break
    }

    const parentDirectory = dirname(currentDirectory)
    if (parentDirectory === currentDirectory) {
      break
    }
    currentDirectory = parentDirectory
  }
}

function readPackageVersion(packageRoot: string): string {
  return resolvePackageVersion(packageRoot)
}

function readPackageName(packageRoot: string): string {
  return resolvePackageName(packageRoot)
}

function readPackageCliDeclaration(packageRoot = findPackageRoot()): { packageJsonPath: string, cliPath: string | undefined } {
  const packageJsonPath = join(packageRoot, 'package.json')
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  if (!isRecord(packageJson)) {
    throw new Error(`Failed to parse ${packageJsonPath}: expected a JSON object at the top level.`)
  }

  const bin = packageJson.bin
  let relativeBinPath: string | undefined
  if (typeof bin === 'string') {
    relativeBinPath = bin
  } else if (isRecord(bin)) {
    for (const cliBinName of CLI_BIN_NAMES) {
      const namedBin = bin[cliBinName]
      if (typeof namedBin === 'string') {
        relativeBinPath = namedBin
        break
      }
    }
    relativeBinPath ??= Object.values(bin).find((value): value is string => typeof value === 'string')
  }

  if (!relativeBinPath) {
    return { packageJsonPath, cliPath: undefined }
  }

  return { packageJsonPath, cliPath: join(packageRoot, relativeBinPath) }
}

function findPackageCliPath(packageRoot = findPackageRoot()): string | undefined {
  const { cliPath } = readPackageCliDeclaration(packageRoot)
  if (!cliPath) {
    return undefined
  }

  let cliPathIsFile = false
  try {
    cliPathIsFile = existsSync(cliPath) && statSync(cliPath).isFile()
  } catch {
    cliPathIsFile = false
  }
  if (!cliPathIsFile) {
    return undefined
  }
  return cliPath
}

function resolvePackageCliPath(packageRoot = findPackageRoot()): string {
  const { packageJsonPath, cliPath } = readPackageCliDeclaration(packageRoot)
  if (!cliPath) {
    throw new Error(`Could not locate a ${CLI_BIN_NAMES.join(' or ')} bin entry in ${packageJsonPath}`)
  }
  if (!existsSync(cliPath) || !statSync(cliPath).isFile()) {
    throw new Error(`Could not locate a ${CLI_BIN_NAMES.join(' or ')} CLI at ${cliPath} declared by ${packageJsonPath}`)
  }
  return cliPath
}

function resolveSkillSourcePath(platform: SkillInstallPlatform, packageRoot: string): string | undefined {
  const config = PLATFORM_CONFIG[platform]
  const candidatePath = join(packageRoot, LOCAL_SKILL_ASSET_DIRECTORY, config.skillFile)

  if (existsSync(candidatePath)) {
    return candidatePath
  }

  return undefined
}

function resolveSkillContent(platform: SkillInstallPlatform, packageRoot: string): string {
  const sourcePath = resolveSkillSourcePath(platform, packageRoot)
  if (sourcePath) {
    const content = readFileSync(sourcePath, 'utf8')
    if (content.trim().length === 0) {
      throw new Error(`error: ${sourcePath} is empty or corrupted`)
    }
    return content
  }

  const content = getBuiltInSkillContent(platform)
  if (content.trim().length === 0) {
    throw new Error(`error: built-in template for ${platform} is empty or corrupted`)
  }
  return content
}

function registerHomeClaudeSkill(homeDir: string): string {
  const claudeMdPath = join(homeDir, '.claude', 'CLAUDE.md')
  ensureParentDirectory(claudeMdPath)
  const registrationBlock = SKILL_REGISTRATION.trimStart()

  if (!existsSync(claudeMdPath)) {
    writeFileSync(claudeMdPath, registrationBlock, 'utf8')
    return `CLAUDE.md -> created at ${claudeMdPath}`
  }

  const content = readFileSync(claudeMdPath, 'utf8')
  if (content.includes(SKILL_REGISTRATION_MARKER)) {
    return 'CLAUDE.md -> already registered (no change)'
  }

  const hasCurrentSection = content.includes(HOME_SECTION_MARKER)
  const cleanedContent = hasCurrentSection ? removeHomeSkillRegistration(content) : content.trimEnd()
  const nextContent = cleanedContent.length > 0 ? `${cleanedContent}\n\n${registrationBlock}` : registrationBlock
  writeFileSync(claudeMdPath, `${nextContent.trimEnd()}\n`, 'utf8')
  return hasCurrentSection ? `CLAUDE.md -> skill registration updated in ${claudeMdPath}` : `CLAUDE.md -> skill registered in ${claudeMdPath}`
}

type McpConfigTarget = 'claude' | 'cursor' | 'copilot'
const MCP_CONFIG_PATHS: Record<McpConfigTarget, string> = {
  claude: '.mcp.json',
  cursor: join('.cursor', 'mcp.json'),
  copilot: join('.vscode', 'mcp.json'),
}

function installPackageSpecifier(packageRoot = findPackageRoot()): string {
  const packageName = readPackageName(packageRoot)
  const version = readPackageVersion(packageRoot)
  if (packageName === 'unknown' || version === 'unknown') {
    throw new Error(`Could not determine package name and version from ${join(packageRoot, 'package.json')}`)
  }

  return `${packageName}@${version}`
}

function installMcpServer(
  projectDir: string,
  target: McpConfigTarget = 'claude',
  nodePlatform = process.platform,
  options: McpInstallOptions = {},
  packageRoot = findPackageRoot(),
): string {
  const mcpJsonPath = join(projectDir, MCP_CONFIG_PATHS[target])
  ensureParentDirectory(mcpJsonPath)
  const mcpConfig = readJsonObject(mcpJsonPath)

  const graphPath = join(projectDir, 'out', 'graph.json')
  const isVscode = target === 'copilot'
  // Use npx.cmd on Windows so MCP server starts without a shell wrapper.
  // --yes skips the interactive install prompt that hangs in stdio mode.
  // Scoped name ensures npx resolves the package on first run.
  // VS Code uses "servers" key, Claude/Cursor use "mcpServers"
  const serversKey = isVscode ? 'servers' : 'mcpServers'
  const mcpServers = ensureRecord(mcpConfig, serversKey)
  const existed = isRecord(mcpServers[SKILL_SLUG])

  const npxCommand = nodePlatform === 'win32' ? 'npx.cmd' : 'npx'
  const npxArgs = ['--yes', installPackageSpecifier(), 'serve', '--stdio', graphPath]
  const directCliPath = isVscode ? findPackageCliPath(packageRoot) : undefined
  const command = directCliPath ? process.execPath : npxCommand
  const args = directCliPath ? [directCliPath, 'serve', '--stdio', graphPath] : npxArgs
  // Default to the lean MCP tool surface ("core" = 6 tools). Reduces cache_creation
  // overhead per session vs. advertising all tools. Users can opt into the full
  // 25-tool surface by setting MADAR_TOOL_PROFILE=full in this env block.
  //
  // Re-running install must NOT silently downgrade an existing user-customized env
  // or drop unrelated user-set env keys. Without an explicit profile flag we merge
  // defaults first, then the existing entry on top so user values win.
  const existingServer = existed ? (mcpServers[SKILL_SLUG] as Record<string, unknown>) : null
  const existingEnv = existingServer && isRecord(existingServer.env) ? (existingServer.env as Record<string, string>) : {}
  const envProfile: McpToolProfile = options.profile === 'full' ? 'full' : 'core'
  const env: Record<string, string> = options.profile
    ? { ...existingEnv, MADAR_TOOL_PROFILE: envProfile }
    : { MADAR_TOOL_PROFILE: 'core', ...existingEnv }
  const serverConfig = isVscode
    ? { type: 'stdio', command, args, env }
    : { command: npxCommand, args: npxArgs, env }

  mcpServers[SKILL_SLUG] = serverConfig
  writeJson(mcpJsonPath, mcpConfig)

  // Clean up legacy mcpServers from .claude/settings.json if present
  if (target === 'claude') {
    const legacySettingsPath = join(projectDir, '.claude', 'settings.json')
    if (existsSync(legacySettingsPath)) {
      const legacySettings = readJsonObject(legacySettingsPath)
      if (isRecord(legacySettings.mcpServers) && Object.hasOwn(legacySettings.mcpServers, SKILL_SLUG)) {
        delete (legacySettings.mcpServers as Record<string, unknown>)[SKILL_SLUG]
        writeJson(legacySettingsPath, legacySettings)
      }
    }
  }

  const displayPath = MCP_CONFIG_PATHS[target]
  return existed ? `${displayPath} -> MCP server updated` : `${displayPath} -> MCP server registered`
}

function uninstallMcpServer(projectDir: string, target: McpConfigTarget): string | undefined {
  const mcpJsonPath = join(projectDir, MCP_CONFIG_PATHS[target])
  if (!existsSync(mcpJsonPath)) {
    return undefined
  }

  const isVscode = target === 'copilot'
  const mcpConfig = readJsonObject(mcpJsonPath)
  const serversKey = isVscode ? 'servers' : 'mcpServers'
  if (!isRecord(mcpConfig[serversKey]) || !Object.hasOwn(mcpConfig[serversKey], SKILL_SLUG)) {
    return undefined
  }

  delete (mcpConfig[serversKey] as Record<string, unknown>)[SKILL_SLUG]
  writeJson(mcpJsonPath, mcpConfig)
  return `${MCP_CONFIG_PATHS[target]} -> MCP server removed`
}

function installClaudeHook(projectDir: string, profile?: InstallProfile): string {
  const settingsPath = join(projectDir, '.claude', 'settings.json')
  const settings = readJsonObject(settingsPath)
  const hooks = ensureRecord(settings, 'hooks')
  const userPromptSubmit = ensureArray(hooks, 'UserPromptSubmit')
  const preToolUse = ensureArray(hooks, 'PreToolUse')

  const existingIndex = userPromptSubmit.findIndex((hook) => isMadarProjectHook(hook))
  if (existingIndex >= 0) {
    userPromptSubmit[existingIndex] = settingsHook(profile)
    hooks.PreToolUse = preToolUse.filter((hook) => !isMadarProjectHook(hook, 'Glob|Grep|Bash|Agent|Read'))
    writeJson(settingsPath, settings)
    return '.claude/settings.json -> hook updated'
  }

  userPromptSubmit.push(settingsHook(profile))
  hooks.PreToolUse = preToolUse.filter((hook) => !isMadarProjectHook(hook, 'Glob|Grep|Bash|Agent|Read'))
  writeJson(settingsPath, settings)
  return '.claude/settings.json -> UserPromptSubmit hook registered'
}

function uninstallClaudeHook(projectDir: string): string | undefined {
  const settingsPath = join(projectDir, '.claude', 'settings.json')
  if (!existsSync(settingsPath)) {
    return undefined
  }

  const settings = readJsonObject(settingsPath)
  const hooks = ensureRecord(settings, 'hooks')
  const userPromptSubmit = ensureArray(hooks, 'UserPromptSubmit')
  const preToolUse = ensureArray(hooks, 'PreToolUse')
  const filteredUserPromptSubmit = userPromptSubmit.filter((hook) => !isMadarProjectHook(hook))
  const filteredPreToolUse = preToolUse.filter((hook) => !isMadarProjectHook(hook, 'Glob|Grep|Bash|Agent|Read'))

  if (filteredUserPromptSubmit.length === userPromptSubmit.length && filteredPreToolUse.length === preToolUse.length) {
    return undefined
  }

  hooks.UserPromptSubmit = filteredUserPromptSubmit
  hooks.PreToolUse = filteredPreToolUse
  writeJson(settingsPath, settings)
  return '.claude/settings.json -> UserPromptSubmit hook removed'
}

function installGeminiHook(projectDir: string, profile?: InstallProfile): string {
  const settingsPath = join(projectDir, '.gemini', 'settings.json')
  const settings = readJsonObject(settingsPath)
  const hooks = ensureRecord(settings, 'hooks')
  const beforeTool = ensureArray(hooks, 'BeforeTool')
  const nextHook = geminiHook(profile)
  const existingIndex = beforeTool.findIndex((hook) => isMadarProjectHook(hook, 'read_file|list_directory|search_for_pattern'))

  if (existingIndex >= 0) {
    if (JSON.stringify(beforeTool[existingIndex]) === JSON.stringify(nextHook)) {
      return '.gemini/settings.json -> BeforeTool hook already registered (no change)'
    }

    beforeTool[existingIndex] = nextHook
    writeJson(settingsPath, settings)
    return '.gemini/settings.json -> BeforeTool hook updated'
  }

  beforeTool.push(nextHook)
  writeJson(settingsPath, settings)
  return '.gemini/settings.json -> BeforeTool hook registered'
}

function uninstallGeminiHook(projectDir: string): string | undefined {
  const settingsPath = join(projectDir, '.gemini', 'settings.json')
  if (!existsSync(settingsPath)) {
    return undefined
  }

  const settings = readJsonObject(settingsPath)
  const hooks = ensureRecord(settings, 'hooks')
  const beforeTool = ensureArray(hooks, 'BeforeTool')
  const filtered = beforeTool.filter((hook) => !JSON.stringify(hook).includes('out'))

  if (filtered.length === beforeTool.length) {
    return undefined
  }

  hooks.BeforeTool = filtered
  writeJson(settingsPath, settings)
  return '.gemini/settings.json -> BeforeTool hook removed'
}

function installCodexHook(projectDir: string): string {
  const hooksPath = join(projectDir, '.codex', 'hooks.json')
  const hooksConfig = readJsonObject(hooksPath)
  const hooks = ensureRecord(hooksConfig, 'hooks')
  const preToolUse = ensureArray(hooks, 'PreToolUse')

  const additions = CODEX_HOOK.hooks.PreToolUse as unknown[]
  let replaced = false
  const updatedPreToolUse = preToolUse.flatMap((hook) => {
    if (!isMadarCodexHook(hook)) {
      return [hook]
    }

    if (replaced) {
      return []
    }

    replaced = true
    return additions
  })

  if (replaced) {
    hooks.PreToolUse = updatedPreToolUse
    writeJson(hooksPath, hooksConfig)
    return '.codex/hooks.json -> hook updated'
  }

  preToolUse.push(...additions)
  writeJson(hooksPath, hooksConfig)
  return '.codex/hooks.json -> PreToolUse hook registered'
}

function uninstallCodexHook(projectDir: string): string | undefined {
  const hooksPath = join(projectDir, '.codex', 'hooks.json')
  if (!existsSync(hooksPath)) {
    return undefined
  }

  const hooksConfig = readJsonObject(hooksPath)
  const hooks = ensureRecord(hooksConfig, 'hooks')
  const preToolUse = ensureArray(hooks, 'PreToolUse')
  const filtered = preToolUse.filter((hook) => !isMadarCodexHook(hook))

  if (filtered.length === preToolUse.length) {
    return undefined
  }

  hooks.PreToolUse = filtered
  writeJson(hooksPath, hooksConfig)
  return '.codex/hooks.json -> PreToolUse hook removed'
}

function installOpencodePlugin(projectDir: string): string[] {
  const pluginPath = join(projectDir, OPENCODE_PLUGIN_RELATIVE_PATH)
  ensureParentDirectory(pluginPath)
  writeFileSync(pluginPath, OPENCODE_PLUGIN_JS, 'utf8')

  const configPath = resolveOpencodeConfigPath(projectDir)
  const configDisplayPath = opencodeConfigDisplayPath(configPath)
  const config = readOpencodeConfig(configPath)
  const pluginWasArray = Array.isArray(config.plugin)
  const plugins = ensureArray(config, 'plugin')
  const messages = ['.opencode/plugins/madar.js -> tool.execute.before hook written']

  if (!plugins.includes(OPENCODE_PLUGIN_RELATIVE_PATH)) {
    plugins.push(OPENCODE_PLUGIN_RELATIVE_PATH)
    writeOpencodePluginRegistration(configPath, config, pluginWasArray)
    messages.push(`${configDisplayPath} -> plugin registered`)
    return messages
  }

  messages.push(`${configDisplayPath} -> plugin already registered (no change)`)
  return messages
}

function installOpencodeMcpServer(projectDir: string, packageRoot?: string): string {
  const configPath = resolveOpencodeConfigPath(projectDir)
  const configDisplayPath = opencodeConfigDisplayPath(configPath)
  const config = readOpencodeConfig(configPath)
  const mcpWasRecord = isRecord(config.mcp)
  const mcp = ensureRecord(config, 'mcp')
  const existingServer = isRecord(mcp[OPENCODE_MCP_SERVER_NAME]) ? (mcp[OPENCODE_MCP_SERVER_NAME] as Record<string, unknown>) : null
  const graphPath = join(projectDir, 'out', 'graph.json')
  const serverConfig: Record<string, unknown> = {
    type: 'local',
    command: [process.execPath, resolvePackageCliPath(packageRoot), 'serve', '--stdio', graphPath],
    enabled: true,
  }

  if (existingServer && isRecord(existingServer.environment)) {
    serverConfig.environment = existingServer.environment
  }

  mcp[OPENCODE_MCP_SERVER_NAME] = serverConfig
  writeOpencodeMcpServerConfig(configPath, config, mcpWasRecord)

  return existingServer ? `${configDisplayPath} -> MCP server updated` : `${configDisplayPath} -> MCP server registered`
}

function uninstallOpencodePlugin(projectDir: string): string[] {
  const pluginPath = join(projectDir, OPENCODE_PLUGIN_RELATIVE_PATH)
  const messages: string[] = []

  if (existsSync(pluginPath)) {
    unlinkSync(pluginPath)
    messages.push('.opencode/plugins/madar.js -> removed')
  }

  const configPath = resolveOpencodeConfigPath(projectDir)
  const configDisplayPath = opencodeConfigDisplayPath(configPath)
  if (!existsSync(configPath)) {
    return messages
  }

  const config = readOpencodeConfig(configPath)
  const plugins = ensureArray(config, 'plugin')
  const filtered = plugins.filter((entry) => entry !== OPENCODE_PLUGIN_RELATIVE_PATH)

  if (filtered.length === plugins.length) {
    return messages
  }

  if (filtered.length === 0) {
    delete config.plugin
  } else {
    config.plugin = filtered
  }

  writeOpencodePluginDeregistration(configPath, config)
  messages.push(`${configDisplayPath} -> plugin deregistered`)
  return messages
}

function uninstallOpencodeMcpServer(projectDir: string): string | undefined {
  const configPath = resolveOpencodeConfigPath(projectDir)
  const configDisplayPath = opencodeConfigDisplayPath(configPath)
  if (!existsSync(configPath)) {
    return undefined
  }

  const config = readOpencodeConfig(configPath)
  if (!isRecord(config.mcp) || !(OPENCODE_MCP_SERVER_NAME in config.mcp)) {
    return undefined
  }

  delete config.mcp[OPENCODE_MCP_SERVER_NAME]
  if (Object.keys(config.mcp).length === 0) {
    delete config.mcp
  }

  writeOpencodeMcpRemovalConfig(configPath, config)
  return `${configDisplayPath} -> MCP server removed`
}

function writeSection(targetPath: string, section: string): string {
  ensureParentDirectory(targetPath)
  const fileLabel = sectionFileDisplayName(targetPath)

  if (!existsSync(targetPath)) {
    writeFileSync(targetPath, section, 'utf8')
    return `madar section written to ${targetPath}`
  }

  const content = readFileSync(targetPath, 'utf8')
  if (content.includes(SECTION_MARKER)) {
    const cleaned = removeSection(content).trimEnd()
    const updated = cleaned.length > 0 ? `${cleaned}\n\n${section}` : section
    writeFileSync(targetPath, updated, 'utf8')
    return `madar section updated in ${targetPath}`
  }

  writeFileSync(targetPath, `${content.trimEnd()}\n\n${section}`, 'utf8')
  return `madar section written to ${targetPath}`
}

function removeSectionFromFile(targetPath: string): string {
  const fileLabel = sectionFileDisplayName(targetPath)

  if (!existsSync(targetPath)) {
    return `No ${fileLabel} found in current directory - nothing to do`
  }

  const content = readFileSync(targetPath, 'utf8')
  if (!content.includes(SECTION_MARKER)) {
    return `madar section not found in ${fileLabel} - nothing to do`
  }

  const cleaned = removeSection(content)
  if (cleaned.length > 0) {
    writeFileSync(targetPath, `${cleaned}\n`, 'utf8')
    return `madar section removed from ${targetPath}`
  }

  rmSync(targetPath, { force: true })
  return `${fileLabel} was empty after removal - deleted ${targetPath}`
}

export function defaultInstallPlatform(nodePlatform = process.platform): InstallPlatform {
  return nodePlatform === 'win32' ? 'windows' : 'claude'
}

export function isInstallPlatform(value: string): value is InstallPlatform {
  return INSTALL_PLATFORMS.includes(value as InstallPlatform)
}

export function isAgentPlatform(value: string): value is AgentPlatform {
  return AGENT_PLATFORMS.includes(value as AgentPlatform)
}

export function isMcpToolProfile(value: string): value is McpToolProfile {
  return MCP_TOOL_PROFILES.includes(value as McpToolProfile)
}

export function isInstallProfile(value: string): value is InstallProfile {
  return INSTALL_PROFILES.includes(value as InstallProfile)
}

export function installSkill(platform: SkillInstallPlatform, options: InstallSkillOptions = {}): string {
  const homeDir = resolve(options.homeDir ?? homedir())
  const packageRoot = resolve(options.packageRoot ?? findPackageRoot())
  const version = options.version ?? readPackageVersion(packageRoot)
  const skillContent = resolveSkillContent(platform, packageRoot)
  const destinationPath = join(homeDir, PLATFORM_CONFIG[platform].skillDestination)

  ensureParentDirectory(destinationPath)
  writeFileSync(destinationPath, skillContent, 'utf8')
  writeFileSync(join(dirname(destinationPath), '.madar_version'), version, 'utf8')

  const messages = [`skill installed -> ${destinationPath}`]
  if (PLATFORM_CONFIG[platform].registerClaudeMd) {
    messages.push(registerHomeClaudeSkill(homeDir))
  }
  messages.push('', 'Done. Open your AI coding assistant and type:', '', '  /madar .')
  return messages.join('\n')
}

export function uninstallSkill(platform: SkillInstallPlatform, options: Pick<InstallSkillOptions, 'homeDir'> = {}): string {
  const homeDir = resolve(options.homeDir ?? homedir())
  const destinationPath = join(homeDir, PLATFORM_CONFIG[platform].skillDestination)
  const messages: string[] = []

  const removalMessage = removeInstalledSkill(destinationPath, homeDir)
  if (removalMessage) {
    messages.push(removalMessage)
  }

  if (messages.length === 0) {
    return 'nothing to remove'
  }

  return messages.join('\n')
}

export function geminiInstall(projectDir = '.', options: GeminiInstallOptions = {}): string {
  const resolvedProjectDir = resolve(projectDir)
  const messages = [installSkill('gemini', options), writeSection(join(resolvedProjectDir, 'GEMINI.md'), geminiMdSection(options.profile)), installGeminiHook(resolvedProjectDir, options.profile)]
  if (options.profile === 'strict') {
    messages.push('', 'Gemini CLI will now use the madar strict compact MCP profile:', `call context_pack once, ${strictContextPackStopRule(false)}, and ${strictContextPackExpandRule(false)}.`)
  } else {
    messages.push('', 'Gemini CLI will now check the knowledge graph before answering', 'codebase questions and rebuild it after code changes.')
  }
  return messages.join('\n')
}

export function geminiUninstall(projectDir = '.', options: Pick<InstallSkillOptions, 'homeDir'> = {}): string {
  const resolvedProjectDir = resolve(projectDir)
  const messages: string[] = []
  const skillMessage = uninstallSkill('gemini', options)
  if (skillMessage !== 'nothing to remove') {
    messages.push(skillMessage)
  }
  messages.push(removeSectionFromFile(join(resolvedProjectDir, 'GEMINI.md')))
  const hookMessage = uninstallGeminiHook(resolvedProjectDir)
  if (hookMessage) {
    messages.push(hookMessage)
  }
  return messages.join('\n')
}

export function installCopilotMcp(projectDir = '.', options: McpInstallOptions = {}, packageRoot = findPackageRoot()): string {
  const message = installMcpServer(resolve(projectDir), 'copilot', process.platform, options, resolve(packageRoot))
  if (options.profile === 'strict') {
    return `${message}\n\nGitHub Copilot will now use the madar strict compact MCP profile: call context_pack once, ${strictContextPackStopRule(false)}, and ${strictContextPackExpandRule(false)}.`
  }
  return message
}

export function uninstallCopilotMcp(projectDir = '.'): string {
  return uninstallMcpServer(resolve(projectDir), 'copilot') ?? 'No madar Copilot MCP server found - nothing to do'
}

export function cursorInstall(projectDir = '.', options: McpInstallOptions = {}): string {
  const resolvedProjectDir = resolve(projectDir)
  const rulePath = join(resolvedProjectDir, CURSOR_RULE_RELATIVE_PATH)
  ensureParentDirectory(rulePath)

  const messages: string[] = []
  const ruleContent = cursorRule(options.profile)

  if (existsSync(rulePath)) {
    if (readFileSync(rulePath, 'utf8') === ruleContent) {
      messages.push(`madar Cursor rule already exists at ${rulePath} (no change)`)
    } else {
      writeFileSync(rulePath, ruleContent, 'utf8')
      messages.push(`madar Cursor rule updated at ${rulePath}`)
    }
  } else {
    writeFileSync(rulePath, ruleContent, 'utf8')
    messages.push(`madar Cursor rule written to ${rulePath}`)
  }

  messages.push(installMcpServer(resolvedProjectDir, 'cursor', process.platform, options))
  if (options.profile === 'strict') {
    messages.push('', 'Cursor will now use the madar strict compact MCP profile:', `call context_pack once, ${strictContextPackStopRule(false)}, and ${strictContextPackExpandRule(false)}.`)
  }
  return messages.join('\n')
}

export function cursorUninstall(projectDir = '.'): string {
  const resolvedProjectDir = resolve(projectDir)
  const messages: string[] = []
  const rulePath = join(resolvedProjectDir, CURSOR_RULE_RELATIVE_PATH)

  if (existsSync(rulePath)) {
    unlinkSync(rulePath)
    messages.push(`madar Cursor rule removed from ${rulePath}`)
  } else {
    messages.push('No madar Cursor rule found - nothing to do')
  }

  const mcpMessage = uninstallMcpServer(resolvedProjectDir, 'cursor')
  if (mcpMessage) {
    messages.push(mcpMessage)
  }

  return messages.join('\n')
}

export function claudeInstall(projectDir = '.', options: McpInstallOptions = {}): string {
  const resolvedProjectDir = resolve(projectDir)
  const messages = [
    writeSection(join(resolvedProjectDir, 'CLAUDE.md'), claudeMdSection(options.profile)),
    installClaudeHook(resolvedProjectDir, options.profile),
    installMcpServer(resolvedProjectDir, 'claude', process.platform, options),
  ]
  if (options.profile === 'strict') {
    messages.push('', 'Claude Code will now use the madar strict compact MCP profile:', `call context_pack once, ${strictContextPackStopRule(false)}, and ${strictContextPackExpandRule(false)}.`)
  } else {
    messages.push('', 'Claude Code will now start with the matching madar MCP tool', 'BEFORE searching raw files for any codebase question.')
  }
  return messages.join('\n')
}

export function claudeUninstall(projectDir = '.'): string {
  const resolvedProjectDir = resolve(projectDir)
  const messages = [removeSectionFromFile(join(resolvedProjectDir, 'CLAUDE.md'))]
  const hookMessage = uninstallClaudeHook(resolvedProjectDir)
  if (hookMessage) {
    messages.push(hookMessage)
  }

  const mcpMessage = uninstallMcpServer(resolvedProjectDir, 'claude')
  if (mcpMessage) {
    messages.push(mcpMessage)
  }

  // Clean up legacy location
  const settingsPath = join(resolvedProjectDir, '.claude', 'settings.json')
  if (existsSync(settingsPath)) {
    const settings = readJsonObject(settingsPath)
    if (isRecord(settings.mcpServers) && Object.hasOwn(settings.mcpServers, SKILL_SLUG)) {
      delete (settings.mcpServers as Record<string, unknown>)[SKILL_SLUG]
      writeJson(settingsPath, settings)
    }
  }

  return messages.join('\n')
}

export function agentsInstall(projectDir = '.', platform: AgentPlatform, options: Pick<InstallSkillOptions, 'packageRoot'> = {}): string {
  const resolvedProjectDir = resolve(projectDir)
  const packageRoot = options.packageRoot ? resolve(options.packageRoot) : undefined
  const displayName = formatPlatformDisplayName(platform)
  const agentsSection =
    platform === 'codex'
      ? CODEX_AGENTS_MD_SECTION
      : platform === 'aider'
        ? AIDER_AGENTS_MD_SECTION
        : platform === 'opencode'
          ? OPENCODE_AGENTS_MD_SECTION
          : AGENTS_MD_SECTION
  const messages = [writeSection(join(resolvedProjectDir, 'AGENTS.md'), agentsSection)]

  if (platform === 'codex') {
    messages.push(installCodexHook(resolvedProjectDir))
  } else if (platform === 'opencode') {
    messages.push(...installOpencodePlugin(resolvedProjectDir))
    messages.push(installOpencodeMcpServer(resolvedProjectDir, packageRoot))
  }

  if (platform === 'codex') {
    messages.push('', 'Codex will now use the madar context-pack-first profile before broad codebase discovery.', 'Uninstall with: madar codex uninstall')
  } else if (platform === 'aider') {
    messages.push('', 'Aider will now use the madar context-pack-first AGENTS.md profile before broad codebase discovery.', 'Uninstall with: madar aider uninstall')
  } else if (platform === 'opencode') {
    messages.push('', 'OpenCode will now use the madar context-pack-first profile before broad codebase discovery.', 'Uninstall with: madar opencode uninstall')
  } else {
    messages.push('', `${displayName} will now check the knowledge graph before answering`, 'codebase questions and rebuild it after code changes.')
  }
  if (platform !== 'codex' && platform !== 'opencode') {
    messages.push('', `Note: unlike Claude Code, there is no PreToolUse hook equivalent for ${displayName} - the AGENTS.md rules are the always-on mechanism.`)
  }
  return messages.join('\n')
}

export function agentsUninstall(projectDir = '.', platform: AgentPlatform): string {
  const resolvedProjectDir = resolve(projectDir)
  const messages = [removeSectionFromFile(join(resolvedProjectDir, 'AGENTS.md'))]

  if (platform === 'codex') {
    const hookMessage = uninstallCodexHook(resolvedProjectDir)
    if (hookMessage) {
      messages.push(hookMessage)
    }
  } else if (platform === 'opencode') {
    messages.push(...uninstallOpencodePlugin(resolvedProjectDir))
    const mcpMessage = uninstallOpencodeMcpServer(resolvedProjectDir)
    if (mcpMessage) {
      messages.push(mcpMessage)
    }
  }

  return messages.join('\n')
}
