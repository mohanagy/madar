import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { getBuiltInSkillContent } from './install-skill-templates.js'
import { renderPlainMcpRoutingGuide } from './install-routing-guidance.js'
import {
  findPackageRoot as resolvePackageRoot,
  readPackageVersion as resolvePackageVersion,
} from '../shared/package-metadata.js'

export const SKILL_INSTALL_PLATFORMS = ['claude', 'gemini', 'codex', 'opencode', 'aider', 'claw', 'droid', 'trae', 'trae-cn', 'copilot', 'windows'] as const

export type SkillInstallPlatform = (typeof SKILL_INSTALL_PLATFORMS)[number]

export const INSTALL_PLATFORMS = [...SKILL_INSTALL_PLATFORMS, 'cursor'] as const

export type InstallPlatform = (typeof INSTALL_PLATFORMS)[number]

export const AGENT_PLATFORMS = ['codex', 'opencode', 'aider', 'claw', 'droid', 'trae', 'trae-cn'] as const

export type AgentPlatform = (typeof AGENT_PLATFORMS)[number]

const MANAGED_HOOK_NAME = 'madar'
const MANAGED_HOOK_SOURCE = 'madar'
export const CLAUDE_PROMPT_HOOK_SCRIPT_RELATIVE_PATH = '.claude/madar-user-prompt-submit.cjs'
const CLAUDE_PROMPT_HOOK_COMMAND = `node ${CLAUDE_PROMPT_HOOK_SCRIPT_RELATIVE_PATH}`
const CLAUDE_PROMPT_HOOK_SCRIPT_MARKER = '// madar managed Claude UserPromptSubmit hook'
export const CODEX_PROMPT_HOOK_SCRIPT_RELATIVE_PATH = '.codex/madar-user-prompt-submit.cjs'
const CODEX_PROMPT_HOOK_SCRIPT_MARKER = '// madar managed Codex UserPromptSubmit hook'
// SECURITY: Keep this command static. It resolves the project script at runtime so
// a nested Codex session works without interpolating a shell-sensitive project path.
const CODEX_PROMPT_HOOK_COMMAND = `node -e "const fs=require('fs');const path=require('path');let dir=process.cwd();for(;;){const script=path.join(dir,'.codex','madar-user-prompt-submit.cjs');if(fs.existsSync(script)){require(script);break}const parent=path.dirname(dir);if(parent===dir){process.exit(0)}dir=parent}"`
export const CODEX_MCP_CONFIG_RELATIVE_PATH = '.codex/config.toml'
export const CODEX_MCP_STARTUP_TIMEOUT_SECONDS = 180
export const CODEX_MCP_TOOL_TIMEOUT_SECONDS = 60
const CODEX_MCP_START_MARKER = '# >>> madar managed mcp >>>'
const CODEX_MCP_END_MARKER = '# <<< madar managed mcp <<<'
const CODEX_MCP_SCOPED_START_MARKER_PREFIX = '# >>> madar managed mcp:'
const CODEX_MCP_SCOPED_END_MARKER_PREFIX = '# <<< madar managed mcp:'
const CODEX_MCP_OWNS_PRECEDING_LINE_ENDING_MARKER = '# madar managed mcp: preceding line ending owned'
const CODEX_MCP_CONFIG_LOCK_SUFFIX = '.madar.lock'
const CODEX_MCP_CONFIG_LOCK_TIMEOUT_MS = 10_000
const CODEX_MCP_CONFIG_LOCK_RETRY_MS = 25
const CODEX_MCP_CONFIG_DEFAULT_MODE = 0o600

interface InstallPlatformConfig {
  skillDestination: string
  registerClaudeMd: boolean
}

interface InstallSkillOptions {
  homeDir?: string
  packageRoot?: string
  version?: string
}

const SKILL_SLUG = 'madar'
const SKILL_COMMAND = '/madar'
const SECTION_MARKER = '## madar'
const HOME_SECTION_MARKER = '# madar'

const PLATFORM_CONFIG: Record<SkillInstallPlatform, InstallPlatformConfig> = {
  claude: {
    skillDestination: '.claude/skills/madar/SKILL.md',
    registerClaudeMd: true,
  },
  gemini: {
    skillDestination: '.gemini/skills/madar/SKILL.md',
    registerClaudeMd: false,
  },
  aider: {
    skillDestination: '.aider/madar/SKILL.md',
    registerClaudeMd: false,
  },
  codex: {
    skillDestination: '.agents/skills/madar/SKILL.md',
    registerClaudeMd: false,
  },
  copilot: {
    skillDestination: '.copilot/skills/madar/SKILL.md',
    registerClaudeMd: false,
  },
  opencode: {
    skillDestination: '.config/opencode/skills/madar/SKILL.md',
    registerClaudeMd: false,
  },
  claw: {
    skillDestination: '.claw/skills/madar/SKILL.md',
    registerClaudeMd: false,
  },
  droid: {
    skillDestination: '.factory/skills/madar/SKILL.md',
    registerClaudeMd: false,
  },
  trae: {
    skillDestination: '.trae/skills/madar/SKILL.md',
    registerClaudeMd: false,
  },
  'trae-cn': {
    skillDestination: '.trae-cn/skills/madar/SKILL.md',
    registerClaudeMd: false,
  },
  windows: {
    skillDestination: '.claude/skills/madar/SKILL.md',
    registerClaudeMd: true,
  },
}

// Cross-platform hook: pass the base64 payload as an argv argument so the
// node -e command stays shell-neutral on macOS, Linux, and Windows.
const WORKSPACE_GRAPH_CHECK_MARKER = 'madar-workspace-graph-check'
const WORKSPACE_GRAPH_CHECK = [
  `/* ${WORKSPACE_GRAPH_CHECK_MARKER} */`,
  `const fs=require('fs'),path=require('path');`,
  `let directory=process.cwd(),hasGraph=false;`,
  `for(;;){`,
  `if(fs.existsSync(path.join(directory,'out','graph.json'))){hasGraph=true;break}`,
  `try{if(fs.lstatSync(path.join(directory,'.git')).isFile()){hasGraph=true;break}}catch(e){}`,
  `const parent=path.dirname(directory);`,
  `if(parent===directory)break;`,
  `directory=parent}`,
].join('')

function hookCommandWithFallback(matchJson: string, missJson: string): string {
  const b64Match = Buffer.from(matchJson).toString('base64')
  const b64Miss = Buffer.from(missJson).toString('base64')
  return `node -e "${WORKSPACE_GRAPH_CHECK};var f=hasGraph?process.argv[1]:process.argv[2];process.stdout.write(Buffer.from(f,'base64').toString())" "${b64Match}" "${b64Miss}"`
}

function hasMadarHookSentinel(hook: Record<string, unknown>): boolean {
  return hook.source === MANAGED_HOOK_SOURCE
    || (typeof hook.source === 'string' && hook.source.startsWith(`${MANAGED_HOOK_SOURCE}:`))
}

function withManagedHookIdentity<T extends Record<string, unknown>>(hook: T): T & { name: string; source: string } {
  return {
    ...hook,
    name: MANAGED_HOOK_NAME,
    source: MANAGED_HOOK_SOURCE,
  }
}

export function isMadarProjectHook(hook: unknown, matcher?: string): boolean {
  if (!isRecord(hook) || !Array.isArray(hook.hooks)) {
    return false
  }

  if (matcher !== undefined && hook.matcher !== matcher) {
    return false
  }

  if (hasMadarHookSentinel(hook)) {
    return true
  }
  return false
}

export function isMadarCodexLegacyHook(hook: unknown): boolean {
  if (!isRecord(hook) || hook.matcher !== 'Bash' || !Array.isArray(hook.hooks)) {
    return false
  }

  if (hasMadarHookSentinel(hook)) {
    return true
  }
  return false
}

export function codexPromptHookCommand(): string {
  return CODEX_PROMPT_HOOK_COMMAND
}

export function claudePromptHookCommand(): string {
  return CLAUDE_PROMPT_HOOK_COMMAND
}

export function isCurrentMadarClaudePromptHook(hook: unknown, expectedCommand: string): boolean {
  if (!isRecord(hook) || !Array.isArray(hook.hooks)) {
    return false
  }

  if (hook.name !== MANAGED_HOOK_NAME || hook.source !== MANAGED_HOOK_SOURCE || hook.hooks.length !== 1) {
    return false
  }

  const entry = hook.hooks[0]
  return isRecord(entry)
    && entry.type === 'command'
    && entry.command === expectedCommand
    && Object.keys(entry).every((key) => key === 'type' || key === 'command')
    && Object.keys(hook).every((key) => key === 'name' || key === 'source' || key === 'hooks')
}

export function isMadarCodexPromptHook(hook: unknown): boolean {
  if (!isRecord(hook) || !Array.isArray(hook.hooks) || !hasMadarHookSentinel(hook)) {
    return false
  }

  return hook.hooks.some(
    (entry) =>
      isRecord(entry) &&
      entry.type === 'command' &&
      typeof entry.command === 'string',
  )
}

export function isCurrentMadarCodexPromptHook(hook: unknown, expectedCommand: string): boolean {
  if (!isRecord(hook) || !Array.isArray(hook.hooks) || !isMadarCodexPromptHook(hook)) {
    return false
  }

  if (hook.name !== MANAGED_HOOK_NAME || hook.source !== MANAGED_HOOK_SOURCE || hook.hooks.length !== 1) {
    return false
  }

  const entry = hook.hooks[0]
  return isRecord(entry)
    && entry.type === 'command'
    && entry.command === expectedCommand
    && Object.keys(entry).every((key) => key === 'type' || key === 'command')
    && Object.keys(hook).every((key) => key === 'name' || key === 'source' || key === 'hooks')
}

const RETRIEVE_FIRST_MESSAGE =
  `This project has a Madar knowledge graph. ${renderPlainMcpRoutingGuide()}`

function codexPromptHook(): Record<string, unknown> {
  return withManagedHookIdentity({
    hooks: [
      {
        type: 'command',
        command: codexPromptHookCommand(),
      },
    ],
  })
}

const SKILL_REGISTRATION =
  `\n${HOME_SECTION_MARKER}\n` +
  `- **${SKILL_SLUG}** (\`~/.claude/skills/${SKILL_SLUG}/SKILL.md\`) - any input to knowledge graph. Trigger: \`${SKILL_COMMAND}\`\n` +
  `When the user types \`${SKILL_COMMAND}\`, invoke the Skill tool with \`skill: "${SKILL_SLUG}"\` before doing anything else.\n`

const CLAUDE_MD_SECTION = `${SECTION_MARKER}

This project has a Madar knowledge graph.

1. For a repository question, call Madar's \`retrieve\` MCP tool exactly once with the user's question unchanged before broad file search.
2. Use returned authenticated excerpts and relationships when \`outcome\` is \`evidence\`.
3. When retrieval returns a boundary instead of evidence, state it and use only focused verification needed to continue.
4. Skip Madar for tasks that do not require local repository context.
`

const AGENTS_MD_SECTION = `${SECTION_MARKER}

For repository questions, call Madar's \`retrieve\` tool exactly once with the user's question unchanged before broad file search. Use authenticated evidence when returned; otherwise report the boundary and continue with focused verification only.
`

const AIDER_AGENTS_MD_SECTION = `${SECTION_MARKER}

### Aider integration

Use \`madar query "<question>"\` once before broad file search for repository questions. Answer from authenticated evidence when available and report explicit boundaries otherwise.
`

const CODEX_AGENTS_MD_SECTION = `${SECTION_MARKER}

### Codex CLI integration

For repository questions, call Madar's \`retrieve\` MCP tool exactly once with the user's question unchanged before broad file search. Use authenticated evidence when available and report explicit boundaries otherwise.
`

const OPENCODE_AGENTS_MD_SECTION = `${SECTION_MARKER}

### OpenCode integration

For repository questions, call Madar's \`retrieve\` MCP tool exactly once with the user's question unchanged before broad file search. Use authenticated evidence when available and report explicit boundaries otherwise.
`

const GEMINI_MD_SECTION = CLAUDE_MD_SECTION

const SKILL_REGISTRATION_MARKER = '- **madar**'
const PRIMARY_CLI_BIN_NAME = 'madar'
const CLI_BIN_NAMES = [PRIMARY_CLI_BIN_NAME] as const
export const OPENCODE_PLUGIN_RELATIVE_PATH = '.opencode/plugins/madar.js'
const OPENCODE_JSON_CONFIG_PATH = 'opencode.json'
const OPENCODE_JSONC_CONFIG_PATH = 'opencode.jsonc'
export const OPENCODE_MCP_SERVER_NAME = 'madar'
const CURSOR_RULE_RELATIVE_PATH = '.cursor/rules/madar.mdc'
const OPENCODE_PLUGIN_REMINDER_COMMAND =
  'echo "[madar] Knowledge graph available. Call retrieve once before broad repository search." && '
const OPENCODE_PLUGIN_JS = `// madar OpenCode plugin
// Injects a knowledge graph reminder before bash tool calls when the graph exists.
import { existsSync, lstatSync } from "fs";
import { dirname, join } from "path";

function hasMadarGraph(directory) {
  let current = directory;
  while (true) {
    if (existsSync(join(current, "out", "graph.json"))) {
      return true;
    }

    // Linked Git worktrees store Madar artifacts outside the checkout. The
    // installed MCP server builds that graph at session startup, so retain the
    // reminder when this workspace is a linked worktree.
    try {
      if (lstatSync(join(current, ".git")).isFile()) {
        return true;
      }
    } catch {}

    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

export const MadarPlugin = async ({ directory }) => {
  let reminded = false;

  return {
    "tool.execute.before": async (input, output) => {
      if (reminded) return;
      if (!hasMadarGraph(directory)) return;

      if (input.tool === "bash") {
          output.args.command =
            ${JSON.stringify(OPENCODE_PLUGIN_REMINDER_COMMAND)} +
            output.args.command;
        reminded = true;
      }
    },
  };
};
`

const CURSOR_RULE = `---
description: use Madar retrieve once before broad repository search
alwaysApply: true
---

For repository questions, call Madar's \`retrieve\` MCP tool exactly once with the user's question unchanged before broad file search. Use authenticated evidence when available and report explicit boundaries otherwise.
`

function claudeMdSection(): string {
  return CLAUDE_MD_SECTION
}

function geminiMdSection(): string {
  return GEMINI_MD_SECTION
}

function cursorRule(): string {
  return CURSOR_RULE
}

function settingsHook(): Record<string, unknown> {
  return withManagedHookIdentity({
    hooks: [
      {
        type: 'command',
        command: claudePromptHookCommand(),
      },
    ],
  })
}

function promptHookScript(payload: unknown): string {
  const output = JSON.stringify(payload)
  return `'use strict'\nprocess.stdout.write(${JSON.stringify(output)})\n`
}

function claudePromptHookScript(): string {
  return `${CLAUDE_PROMPT_HOOK_SCRIPT_MARKER}\n${promptHookScript({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: RETRIEVE_FIRST_MESSAGE,
    },
  })}`
}

export function hasManagedClaudePromptHookScript(scriptPath: string): boolean {
  try {
    if (!lstatSync(scriptPath).isFile()) {
      return false
    }

    const content = readFileSync(scriptPath, 'utf8')
    return content === claudePromptHookScript()
  } catch {
    return false
  }
}

function hasClaudePromptHookScriptPath(scriptPath: string): boolean {
  try {
    lstatSync(scriptPath)
    return true
  } catch {
    return false
  }
}

function isMadarClaudePromptHookScript(scriptPath: string): boolean {
  try {
    return lstatSync(scriptPath).isFile()
      && readFileSync(scriptPath, 'utf8').startsWith(`${CLAUDE_PROMPT_HOOK_SCRIPT_MARKER}\n`)
  } catch {
    return false
  }
}

function assertClaudePromptHookScriptIsSafe(projectDir: string): void {
  const hookScriptPath = join(projectDir, CLAUDE_PROMPT_HOOK_SCRIPT_RELATIVE_PATH)
  if (hasClaudePromptHookScriptPath(hookScriptPath)
    && !isMadarClaudePromptHookScript(hookScriptPath)) {
    throw new Error(`Refusing to overwrite user-managed Claude hook script at ${hookScriptPath}`)
  }
}

function writeClaudePromptHookScript(projectDir: string): void {
  const hookScriptPath = join(projectDir, CLAUDE_PROMPT_HOOK_SCRIPT_RELATIVE_PATH)
  assertClaudePromptHookScriptIsSafe(projectDir)
  mkdirSync(dirname(hookScriptPath), { recursive: true })
  writeFileSync(hookScriptPath, claudePromptHookScript(), 'utf8')
}

function codexPromptHookScript(): string {
  return `${CODEX_PROMPT_HOOK_SCRIPT_MARKER}\n${promptHookScript({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: RETRIEVE_FIRST_MESSAGE,
    },
  })}`
}

function isMadarCodexPromptHookScript(content: string): boolean {
  return content.startsWith(`${CODEX_PROMPT_HOOK_SCRIPT_MARKER}\n`)
}

export function hasManagedCodexPromptHookScript(scriptPath: string): boolean {
  if (!existsSync(scriptPath)) {
    return false
  }

  return readFileSync(scriptPath, 'utf8') === codexPromptHookScript()
}

function assertCodexPromptHookScriptIsSafe(projectDir: string): void {
  const hookScriptPath = join(projectDir, CODEX_PROMPT_HOOK_SCRIPT_RELATIVE_PATH)
  if (existsSync(hookScriptPath) && !isMadarCodexPromptHookScript(readFileSync(hookScriptPath, 'utf8'))) {
    throw new Error(`Refusing to overwrite user-managed Codex hook script at ${hookScriptPath}`)
  }
}

function writeCodexPromptHookScript(projectDir: string): void {
  const hookScriptPath = join(projectDir, CODEX_PROMPT_HOOK_SCRIPT_RELATIVE_PATH)
  const script = codexPromptHookScript()
  assertCodexPromptHookScriptIsSafe(projectDir)
  if (existsSync(hookScriptPath) && readFileSync(hookScriptPath, 'utf8') === script) {
    return
  }

  mkdirSync(dirname(hookScriptPath), { recursive: true })
  writeFileSync(hookScriptPath, script, 'utf8')
}

function geminiHook(): Record<string, unknown> {
  return withManagedHookIdentity({
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
  })
}

export function isCurrentMadarGeminiHook(hook: unknown): boolean {
  return JSON.stringify(hook) === JSON.stringify(geminiHook())
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

function removeEmptyHookConfigEntries(config: Record<string, unknown>): void {
  if (!isRecord(config.hooks)) {
    return
  }

  const hooks = config.hooks
  for (const key of ['UserPromptSubmit', 'PreToolUse', 'BeforeTool']) {
    if (Array.isArray(hooks[key]) && hooks[key].length === 0) {
      delete hooks[key]
    }
  }
  if (Object.keys(hooks).length === 0) {
    delete config.hooks
  }
}

export function resolveOpencodeConfigPath(projectDir: string): string {
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

export function readOpencodeConfig(filePath: string): Record<string, unknown> {
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

function resolveSkillContent(platform: SkillInstallPlatform): string {
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

type McpConfigTarget = 'claude' | 'cursor' | 'copilot' | 'gemini'
const MCP_CONFIG_PATHS: Record<McpConfigTarget, string> = {
  claude: '.mcp.json',
  cursor: join('.cursor', 'mcp.json'),
  copilot: join('.vscode', 'mcp.json'),
  gemini: join('.gemini', 'settings.json'),
}

function installMcpServer(
  projectDir: string,
  target: McpConfigTarget = 'claude',
  packageRoot = findPackageRoot(),
): string {
  const mcpJsonPath = join(projectDir, MCP_CONFIG_PATHS[target])
  ensureParentDirectory(mcpJsonPath)
  const mcpConfig = readJsonObject(mcpJsonPath)

  const isVscode = target === 'copilot'
  // Resolve the graph from the MCP process's workspace at startup. A static
  // install-time graph path would point every linked worktree back to the
  // primary checkout.
  const cliArgs = ['serve', '--stdio', '--auto-refresh']
  // VS Code uses "servers" key, Claude/Cursor use "mcpServers"
  const serversKey = isVscode ? 'servers' : 'mcpServers'
  const mcpServers = ensureRecord(mcpConfig, serversKey)
  const existed = isRecord(mcpServers[SKILL_SLUG])

  const directCliPath = isVscode ? findPackageCliPath(packageRoot) : undefined
  const command = directCliPath ? process.execPath : PRIMARY_CLI_BIN_NAME
  const args = directCliPath ? [directCliPath, ...cliArgs] : cliArgs
  const existingServer = existed ? (mcpServers[SKILL_SLUG] as Record<string, unknown>) : null
  const existingEnv = existingServer && isRecord(existingServer.env)
    ? { ...(existingServer.env as Record<string, string>) }
    : {}
  delete existingEnv.MADAR_TOOL_PROFILE
  const serverConfig = isVscode
    ? {
      type: 'stdio',
      command,
      args,
      ...(Object.keys(existingEnv).length > 0 ? { env: existingEnv } : {}),
    }
    : {
      command,
      args,
      ...(Object.keys(existingEnv).length > 0 ? { env: existingEnv } : {}),
    }

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

  const servers = mcpConfig[serversKey] as Record<string, unknown>
  delete servers[SKILL_SLUG]
  if (Object.keys(servers).length === 0) {
    delete mcpConfig[serversKey]
  }
  writeJson(mcpJsonPath, mcpConfig)
  return `${MCP_CONFIG_PATHS[target]} -> MCP server removed`
}

function installClaudeHook(projectDir: string): string {
  const settingsPath = join(projectDir, '.claude', 'settings.json')
  const settings = readJsonObject(settingsPath)
  const hooks = ensureRecord(settings, 'hooks')
  const userPromptSubmit = ensureArray(hooks, 'UserPromptSubmit')
  const preToolUse = ensureArray(hooks, 'PreToolUse')

  writeClaudePromptHookScript(projectDir)

  const existingIndex = userPromptSubmit.findIndex((hook) => isMadarProjectHook(hook))
  const filteredPreToolUse = preToolUse.filter((hook) => !isMadarProjectHook(hook, 'Glob|Grep|Bash|Agent|Read'))
  if (existingIndex >= 0) {
    userPromptSubmit[existingIndex] = settingsHook()
    if (filteredPreToolUse.length === 0) {
      delete hooks.PreToolUse
    } else {
      hooks.PreToolUse = filteredPreToolUse
    }
    writeJson(settingsPath, settings)
    return '.claude/settings.json -> hook updated'
  }

  userPromptSubmit.push(settingsHook())
  if (filteredPreToolUse.length === 0) {
    delete hooks.PreToolUse
  } else {
    hooks.PreToolUse = filteredPreToolUse
  }
  writeJson(settingsPath, settings)
  return '.claude/settings.json -> UserPromptSubmit hook registered'
}

function uninstallClaudeHook(projectDir: string): string | undefined {
  const hookScriptPath = join(projectDir, CLAUDE_PROMPT_HOOK_SCRIPT_RELATIVE_PATH)
  const removedHookScript = isMadarClaudePromptHookScript(hookScriptPath)
  if (removedHookScript) {
    rmSync(hookScriptPath, { force: true })
  }

  const settingsPath = join(projectDir, '.claude', 'settings.json')
  if (!existsSync(settingsPath)) {
    return removedHookScript ? `${CLAUDE_PROMPT_HOOK_SCRIPT_RELATIVE_PATH} -> hook script removed` : undefined
  }

  const settings = readJsonObject(settingsPath)
  const hooks = ensureRecord(settings, 'hooks')
  const userPromptSubmit = ensureArray(hooks, 'UserPromptSubmit')
  const preToolUse = ensureArray(hooks, 'PreToolUse')
  const filteredUserPromptSubmit = userPromptSubmit.filter((hook) => !isMadarProjectHook(hook))
  const filteredPreToolUse = preToolUse.filter((hook) => !isMadarProjectHook(hook, 'Glob|Grep|Bash|Agent|Read'))

  if (filteredUserPromptSubmit.length === userPromptSubmit.length && filteredPreToolUse.length === preToolUse.length) {
    return removedHookScript ? `${CLAUDE_PROMPT_HOOK_SCRIPT_RELATIVE_PATH} -> hook script removed` : undefined
  }

  if (filteredUserPromptSubmit.length === 0) {
    delete hooks.UserPromptSubmit
  } else {
    hooks.UserPromptSubmit = filteredUserPromptSubmit
  }
  if (filteredPreToolUse.length === 0) {
    delete hooks.PreToolUse
  } else {
    hooks.PreToolUse = filteredPreToolUse
  }
  removeEmptyHookConfigEntries(settings)
  writeJson(settingsPath, settings)
  return '.claude/settings.json -> UserPromptSubmit hook removed'
}

function installGeminiHook(projectDir: string): string {
  const settingsPath = join(projectDir, '.gemini', 'settings.json')
  const settings = readJsonObject(settingsPath)
  const hooks = ensureRecord(settings, 'hooks')
  const beforeTool = ensureArray(hooks, 'BeforeTool')
  const nextHook = geminiHook()
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
  const filtered = beforeTool.filter((hook) => !isMadarProjectHook(hook, 'read_file|list_directory|search_for_pattern'))

  if (filtered.length === beforeTool.length) {
    return undefined
  }

  if (filtered.length === 0) {
    delete hooks.BeforeTool
  } else {
    hooks.BeforeTool = filtered
  }
  removeEmptyHookConfigEntries(settings)
  writeJson(settingsPath, settings)
  return '.gemini/settings.json -> BeforeTool hook removed'
}

interface ManagedCodexMcpBlock {
  start: number
  end: number
  content: string
  ownsPrecedingLineEnding: boolean
}

function lineEndingForContent(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n'
}

interface TextRange {
  start: number
  end: number
}

function isEscapedTomlBasicStringCharacter(content: string, index: number): boolean {
  let backslashCount = 0
  for (let cursor = index - 1; cursor >= 0 && content[cursor] === '\\'; cursor -= 1) {
    backslashCount += 1
  }
  return backslashCount % 2 === 1
}

function tomlMultilineStringRanges(content: string): TextRange[] {
  const ranges: TextRange[] = []
  let mode: 'normal' | 'basic' | 'literal' | 'multiline_basic' | 'multiline_literal' = 'normal'
  let multilineStart = -1

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!

    if (mode === 'normal') {
      if (character === '#') {
        const nextLineBreak = content.indexOf('\n', index)
        if (nextLineBreak === -1) {
          break
        }
        index = nextLineBreak
        continue
      }
      if (content.startsWith('"""', index)) {
        mode = 'multiline_basic'
        multilineStart = index
        index += 2
        continue
      }
      if (content.startsWith("'''", index)) {
        mode = 'multiline_literal'
        multilineStart = index
        index += 2
        continue
      }
      if (character === '"') {
        mode = 'basic'
      } else if (character === "'") {
        mode = 'literal'
      }
      continue
    }

    if (mode === 'basic') {
      if (character === '\\') {
        index += 1
      } else if (character === '"' || character === '\n') {
        mode = 'normal'
      }
      continue
    }

    if (mode === 'literal') {
      if (character === "'" || character === '\n') {
        mode = 'normal'
      }
      continue
    }

    const closingDelimiter = mode === 'multiline_basic' ? '"""' : "'''"
    if (content.startsWith(closingDelimiter, index)
      && (mode === 'multiline_literal' || !isEscapedTomlBasicStringCharacter(content, index))) {
      ranges.push({ start: multilineStart, end: index + closingDelimiter.length })
      mode = 'normal'
      multilineStart = -1
      index += closingDelimiter.length - 1
    }
  }

  if (multilineStart >= 0) {
    ranges.push({ start: multilineStart, end: content.length })
  }

  return ranges
}

function isInsideTextRanges(index: number, ranges: readonly TextRange[]): boolean {
  return ranges.some((range) => index >= range.start && index < range.end)
}

function standaloneMarkerPositions(content: string, marker: string, multilineStringRanges: readonly TextRange[]): number[] {
  const positions: number[] = []
  let start = 0

  while (start < content.length) {
    const index = content.indexOf(marker, start)
    if (index === -1) {
      break
    }

    if (isInsideTextRanges(index, multilineStringRanges)) {
      start = index + marker.length
      continue
    }

    const lineStart = content.lastIndexOf('\n', index - 1) + 1
    const nextLineBreak = content.indexOf('\n', index)
    const lineEnd = nextLineBreak === -1 ? content.length : nextLineBreak
    const line = content.slice(lineStart, lineEnd).replace(/\r$/, '')
    if (line.trim() === marker) {
      positions.push(index)
    }

    start = index + marker.length
  }

  return positions
}

function readManagedCodexMcpBlock(
  content: string,
  startMarker = CODEX_MCP_START_MARKER,
  endMarker = CODEX_MCP_END_MARKER,
): ManagedCodexMcpBlock | null {
  const multilineStringRanges = tomlMultilineStringRanges(content)
  const starts = standaloneMarkerPositions(content, startMarker, multilineStringRanges)
  const ends = standaloneMarkerPositions(content, endMarker, multilineStringRanges)

  if (starts.length === 0 && ends.length === 0) {
    return null
  }

  if (starts.length !== 1 || ends.length !== 1 || ends[0]! < starts[0]!) {
    throw new Error(`Malformed Codex Madar MCP marker block in ${CODEX_MCP_CONFIG_RELATIVE_PATH}`)
  }

  const endMarkerStart = ends[0]!
  const lineBreak = content.indexOf('\n', endMarkerStart)
  const end = lineBreak === -1 ? content.length : lineBreak + 1
  const start = starts[0]!
  return {
    start,
    end,
    content: content.slice(start, end),
    ownsPrecedingLineEnding: content
      .slice(start, end)
      .replaceAll('\r\n', '\n')
      .startsWith(`${startMarker}\n${CODEX_MCP_OWNS_PRECEDING_LINE_ENDING_MARKER}\n`),
  }
}

function codexMcpServerName(projectDir: string): string {
  const workspaceId = createHash('sha256').update(resolve(projectDir)).digest('hex').slice(0, 12)
  return `madar_${workspaceId}`
}

function scopedCodexMcpStartMarker(serverName: string): string {
  return `${CODEX_MCP_SCOPED_START_MARKER_PREFIX} ${serverName} >>>`
}

function scopedCodexMcpEndMarker(serverName: string): string {
  return `${CODEX_MCP_SCOPED_END_MARKER_PREFIX} ${serverName} <<<`
}

export function resolveCodexMcpConfigPath(): string {
  const configuredHome = process.env.CODEX_HOME?.trim()
  const codexHome = configuredHome && configuredHome.length > 0
    ? resolve(configuredHome)
    : join(homedir(), '.codex')
  return join(codexHome, 'config.toml')
}

function pauseSynchronously(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function tryAcquireCodexConfigLock(lockPath: string): number | null {
  try {
    // Keep the lock private because the adjacent Codex config can contain
    // credentials or other user-level settings.
    return openSync(lockPath, 'wx', CODEX_MCP_CONFIG_DEFAULT_MODE)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined
    if (code === 'EEXIST') {
      return null
    }
    throw error
  }
}

/**
 * Serialize Madar's read-modify-write operations on Codex's shared user
 * configuration. The lock is intentionally adjacent to the config so all
 * worktrees that resolve the same CODEX_HOME contend on the same path.
 */
function withCodexConfigLock<T>(configPath: string, action: () => T): T {
  const lockPath = `${configPath}${CODEX_MCP_CONFIG_LOCK_SUFFIX}`
  const startedAt = Date.now()
  ensureParentDirectory(lockPath)

  while (true) {
    const lockDescriptor = tryAcquireCodexConfigLock(lockPath)
    if (lockDescriptor !== null) {
      try {
        return action()
      } finally {
        try {
          closeSync(lockDescriptor)
        } finally {
          rmSync(lockPath, { force: true })
        }
      }
    }

    if (Date.now() - startedAt >= CODEX_MCP_CONFIG_LOCK_TIMEOUT_MS) {
      throw new Error(
        `Timed out waiting for another Madar Codex configuration update at ${configPath}. `
        + `If no Madar process is still updating it, remove ${lockPath} and retry.`,
      )
    }
    pauseSynchronously(CODEX_MCP_CONFIG_LOCK_RETRY_MS)
  }
}

/** Publish an updated config through a same-directory atomic rename. */
function writeCodexConfigAtomically(configPath: string, content: string): void {
  ensureParentDirectory(configPath)
  const mode = existsSync(configPath)
    ? statSync(configPath).mode & 0o777
    : CODEX_MCP_CONFIG_DEFAULT_MODE
  const temporaryPath = join(
    dirname(configPath),
    `.${basename(configPath)}.madar-${process.pid}-${randomUUID()}.tmp`,
  )
  let temporaryDescriptor: number | null = null

  try {
    temporaryDescriptor = openSync(temporaryPath, 'wx', mode)
    writeFileSync(temporaryDescriptor, content, 'utf8')
    // openSync's mode is subject to umask, so restore the exact existing mode
    // before publishing the replacement.
    chmodSync(temporaryPath, mode)
    fsyncSync(temporaryDescriptor)
    closeSync(temporaryDescriptor)
    temporaryDescriptor = null
    renameSync(temporaryPath, configPath)
  } finally {
    try {
      if (temporaryDescriptor !== null) {
        closeSync(temporaryDescriptor)
      }
    } finally {
      rmSync(temporaryPath, { force: true })
    }
  }
}

function stripTomlComments(content: string): string {
  let result = ''
  let quote: 'single' | 'double' | null = null
  let escaped = false
  const multilineStringRanges = tomlMultilineStringRanges(content)

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!

    if (isInsideTextRanges(index, multilineStringRanges)) {
      result += character === '\n' ? '\n' : ' '
      continue
    }

    if (quote !== null) {
      result += character
      if (quote === 'double' && escaped) {
        escaped = false
      } else if (quote === 'double' && character === '\\') {
        escaped = true
      } else if ((quote === 'double' && character === '"') || (quote === 'single' && character === "'")) {
        quote = null
      }
      continue
    }

    if (character === '"') {
      quote = 'double'
      result += character
      continue
    }
    if (character === "'") {
      quote = 'single'
      result += character
      continue
    }
    if (character === '#') {
      while (index < content.length && content[index] !== '\n') {
        index += 1
      }
      if (index < content.length) {
        result += '\n'
      }
      continue
    }

    result += character
  }

  return result
}

function hasUserManagedCodexMcpDeclaration(content: string, serverName: string): boolean {
  const serverPath = `mcp_servers.${serverName}`
  const lines = stripTomlComments(content).split(/\r?\n/)
  let currentTable: string | null = null

  for (const line of lines) {
    const arrayTableMatch = /^\s*\[\[\s*([^\]]+?)\s*\]\]\s*$/.exec(line)
    if (arrayTableMatch?.[1]) {
      const tableName = arrayTableMatch[1].replace(/[\s"']/g, '')
      if (tableName === 'mcp_servers' || tableName === serverPath || tableName.startsWith(`${serverPath}.`)) {
        return true
      }
      currentTable = null
      continue
    }

    const tableMatch = /^\s*\[\s*([^\]]+?)\s*\]\s*$/.exec(line)
    if (tableMatch?.[1]) {
      const tableName = tableMatch[1].replace(/[\s"']/g, '')
      if (tableName === serverPath || tableName.startsWith(`${serverPath}.`)) {
        return true
      }
      currentTable = tableName
      continue
    }

    const assignmentIndex = line.indexOf('=')
    if (assignmentIndex === -1) {
      continue
    }

    const keyPath = line.slice(0, assignmentIndex).replace(/[\s"']/g, '')
    if (currentTable === null && (
      keyPath === 'mcp_servers'
      || keyPath === serverPath
      || keyPath.startsWith(`${serverPath}.`)
    )) {
      return true
    }
    if (currentTable === 'mcp_servers' && (keyPath === serverName || keyPath.startsWith(`${serverName}.`))) {
      return true
    }
  }

  return false
}

function renderCodexMcpBlock(
  projectDir: string,
  serverName: string,
  lineEnding: string,
  ownsPrecedingLineEnding = false,
): string {
  return [
    scopedCodexMcpStartMarker(serverName),
    ...(ownsPrecedingLineEnding ? [CODEX_MCP_OWNS_PRECEDING_LINE_ENDING_MARKER] : []),
    `[mcp_servers.${serverName}]`,
    'command = "madar"',
    'args = ["serve", "--stdio", "--auto-refresh"]',
    `cwd = ${JSON.stringify(resolve(projectDir))}`,
    'enabled = true',
    `startup_timeout_sec = ${CODEX_MCP_STARTUP_TIMEOUT_SECONDS}`,
    `tool_timeout_sec = ${CODEX_MCP_TOOL_TIMEOUT_SECONDS}`,
    scopedCodexMcpEndMarker(serverName),
    '',
  ].join(lineEnding)
}

export function isMadarCodexMcpConfig(content: string, projectDir: string): boolean {
  try {
    const serverName = codexMcpServerName(projectDir)
    const managedBlock = readManagedCodexMcpBlock(
      content,
      scopedCodexMcpStartMarker(serverName),
      scopedCodexMcpEndMarker(serverName),
    )
    if (!managedBlock) {
      return false
    }

    const unownedContent = `${content.slice(0, managedBlock.start)}${content.slice(managedBlock.end)}`
    if (hasUserManagedCodexMcpDeclaration(unownedContent, serverName)) {
      return false
    }

    const normalizedBlock = managedBlock.content.replaceAll('\r\n', '\n')
    const expectedBlock = renderCodexMcpBlock(projectDir, serverName, '\n', managedBlock.ownsPrecedingLineEnding)
    return normalizedBlock === expectedBlock
  } catch {
    return false
  }
}

function assertCodexMcpConfigIsSafe(projectDir: string): void {
  const globalConfigPath = resolveCodexMcpConfigPath()
  const serverName = codexMcpServerName(projectDir)
  if (existsSync(globalConfigPath)) {
    // Preserve the preflight failure behavior without observing the shared
    // config outside its lock. The mutation path re-reads it under a fresh
    // lock immediately before it updates the scoped block.
    withCodexConfigLock(globalConfigPath, () => {
      if (existsSync(globalConfigPath)) {
        readManagedCodexMcpBlock(
          readFileSync(globalConfigPath, 'utf8'),
          scopedCodexMcpStartMarker(serverName),
          scopedCodexMcpEndMarker(serverName),
        )
      }
    })
  }

  const legacyConfigPath = join(projectDir, CODEX_MCP_CONFIG_RELATIVE_PATH)
  if (existsSync(legacyConfigPath)) {
    readManagedCodexMcpBlock(readFileSync(legacyConfigPath, 'utf8'))
  }
}

function removeManagedCodexMcpBlock(configPath: string, content: string, managedBlock: ManagedCodexMcpBlock): void {
  const beforeBlock = content.slice(0, managedBlock.start)
  const afterBlock = content.slice(managedBlock.end)
  const precedingLineEnding = beforeBlock.endsWith('\r\n')
    ? '\r\n'
    : beforeBlock.endsWith('\n')
      ? '\n'
      : ''
  const beforeWithoutOwnedLineEnding = managedBlock.ownsPrecedingLineEnding && precedingLineEnding.length > 0
    ? beforeBlock.slice(0, -precedingLineEnding.length)
    : beforeBlock
  const needsLineEndingBeforeAfterBlock = managedBlock.ownsPrecedingLineEnding
    && precedingLineEnding.length > 0
    && afterBlock.length > 0
    && !afterBlock.startsWith('\n')
    && !afterBlock.startsWith('\r')
  writeCodexConfigAtomically(
    configPath,
    `${beforeWithoutOwnedLineEnding}${needsLineEndingBeforeAfterBlock ? precedingLineEnding : ''}${afterBlock}`,
  )
}

function removeLegacyCodexMcpServer(projectDir: string): string | undefined {
  const configPath = join(projectDir, CODEX_MCP_CONFIG_RELATIVE_PATH)
  if (!existsSync(configPath)) {
    return undefined
  }

  const content = readFileSync(configPath, 'utf8')
  const managedBlock = readManagedCodexMcpBlock(content)
  if (!managedBlock) {
    return undefined
  }

  removeManagedCodexMcpBlock(configPath, content, managedBlock)
  return '.codex/config.toml -> obsolete project-local MCP registration removed'
}

function installCodexMcpServer(projectDir: string): string {
  const configPath = resolveCodexMcpConfigPath()
  const serverName = codexMcpServerName(projectDir)
  return withCodexConfigLock(configPath, () => {
    // Re-read after acquiring the shared lock. A different worktree may have
    // added or removed its scoped block while this install was waiting.
    const content = existsSync(configPath) ? readFileSync(configPath, 'utf8') : ''
    const managedBlock = readManagedCodexMcpBlock(
      content,
      scopedCodexMcpStartMarker(serverName),
      scopedCodexMcpEndMarker(serverName),
    )
    const lineEnding = lineEndingForContent(content)
    const ownsPrecedingLineEnding = managedBlock?.ownsPrecedingLineEnding
      ?? (content.length > 0 && !content.endsWith('\n'))
    const nextBlock = renderCodexMcpBlock(projectDir, serverName, lineEnding, ownsPrecedingLineEnding)
    const unownedContent = managedBlock
      ? `${content.slice(0, managedBlock.start)}${content.slice(managedBlock.end)}`
      : content

    if (hasUserManagedCodexMcpDeclaration(unownedContent, serverName)) {
      return `${configPath} -> MCP server ${serverName} is user-managed (no change)`
    }

    let registrationMessage: string
    if (managedBlock) {
      if (managedBlock.content === nextBlock) {
        registrationMessage = `${configPath} -> MCP server ${serverName} already registered (no change)`
      } else {
        writeCodexConfigAtomically(
          configPath,
          `${content.slice(0, managedBlock.start)}${nextBlock}${content.slice(managedBlock.end)}`,
        )
        registrationMessage = `${configPath} -> MCP server ${serverName} updated`
      }
    } else {
      const separator = ownsPrecedingLineEnding ? lineEnding : ''
      writeCodexConfigAtomically(configPath, `${content}${separator}${nextBlock}`)
      registrationMessage = `${configPath} -> MCP server ${serverName} registered`
    }

    const legacyMessage = removeLegacyCodexMcpServer(projectDir)
    return legacyMessage ? `${registrationMessage}\n${legacyMessage}` : registrationMessage
  })
}

function uninstallCodexMcpServer(projectDir: string): string | undefined {
  const configPath = resolveCodexMcpConfigPath()
  const serverName = codexMcpServerName(projectDir)
  return withCodexConfigLock(configPath, () => {
    // Match installation's critical section so an uninstall cannot write a
    // stale snapshot over another worktree's newly registered block.
    if (!existsSync(configPath)) {
      return removeLegacyCodexMcpServer(projectDir)
    }

    const content = readFileSync(configPath, 'utf8')
    const managedBlock = readManagedCodexMcpBlock(
      content,
      scopedCodexMcpStartMarker(serverName),
      scopedCodexMcpEndMarker(serverName),
    )
    if (!managedBlock) {
      return removeLegacyCodexMcpServer(projectDir)
    }

    removeManagedCodexMcpBlock(configPath, content, managedBlock)
    const legacyMessage = removeLegacyCodexMcpServer(projectDir)
    const registrationMessage = `${configPath} -> MCP server ${serverName} removed`
    return legacyMessage ? `${registrationMessage}\n${legacyMessage}` : registrationMessage
  })
}

function installCodexHook(projectDir: string): string {
  const hooksPath = join(projectDir, '.codex', 'hooks.json')
  const hooksConfig = readJsonObject(hooksPath)
  const hooks = ensureRecord(hooksConfig, 'hooks')
  const userPromptSubmit = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit : []
  const preToolUse = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : []
  const nextHook = codexPromptHook()

  writeCodexPromptHookScript(projectDir)

  const filteredUserPromptSubmit = userPromptSubmit.filter((hook) => !isMadarCodexPromptHook(hook))
  const filteredPreToolUse = preToolUse.filter((hook) => !isMadarCodexLegacyHook(hook))
  const removedLegacyHooks = filteredPreToolUse.length !== preToolUse.length
  const managedModernHooks = userPromptSubmit.filter((hook) => isMadarCodexPromptHook(hook))
  const existingModernHook = managedModernHooks[0]
  const modernHookIsCurrent = managedModernHooks.length === 1
    && existingModernHook !== undefined
    && JSON.stringify(existingModernHook) === JSON.stringify(nextHook)

  if (modernHookIsCurrent && !removedLegacyHooks) {
    return '.codex/hooks.json -> UserPromptSubmit hook already registered (no change)'
  }

  hooks.UserPromptSubmit = [...filteredUserPromptSubmit, nextHook]
  if (Object.hasOwn(hooks, 'PreToolUse')) {
    if (filteredPreToolUse.length === 0) {
      delete hooks.PreToolUse
    } else {
      hooks.PreToolUse = filteredPreToolUse
    }
  }

  writeJson(hooksPath, hooksConfig)
  return existingModernHook || removedLegacyHooks
    ? '.codex/hooks.json -> hook updated'
    : '.codex/hooks.json -> UserPromptSubmit hook registered'
}

function uninstallCodexHook(projectDir: string): string | undefined {
  const hookScriptPath = join(projectDir, CODEX_PROMPT_HOOK_SCRIPT_RELATIVE_PATH)
  const removedHookScript = existsSync(hookScriptPath)
    && isMadarCodexPromptHookScript(readFileSync(hookScriptPath, 'utf8'))
  if (removedHookScript) {
    rmSync(hookScriptPath, { force: true })
  }

  const hooksPath = join(projectDir, '.codex', 'hooks.json')
  if (!existsSync(hooksPath)) {
    return removedHookScript ? `${CODEX_PROMPT_HOOK_SCRIPT_RELATIVE_PATH} -> hook script removed` : undefined
  }

  const hooksConfig = readJsonObject(hooksPath)
  const hooks = ensureRecord(hooksConfig, 'hooks')
  const userPromptSubmit = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit : []
  const preToolUse = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : []
  const filteredUserPromptSubmit = userPromptSubmit.filter((hook) => !isMadarCodexPromptHook(hook))
  const filteredPreToolUse = preToolUse.filter((hook) => !isMadarCodexLegacyHook(hook))
  const removedModernHooks = filteredUserPromptSubmit.length !== userPromptSubmit.length
  const removedLegacyHooks = filteredPreToolUse.length !== preToolUse.length

  if (!removedModernHooks && !removedLegacyHooks) {
    return removedHookScript ? `${CODEX_PROMPT_HOOK_SCRIPT_RELATIVE_PATH} -> hook script removed` : undefined
  }

  if (Object.hasOwn(hooks, 'UserPromptSubmit')) {
    if (filteredUserPromptSubmit.length === 0) {
      delete hooks.UserPromptSubmit
    } else {
      hooks.UserPromptSubmit = filteredUserPromptSubmit
    }
  }
  if (Object.hasOwn(hooks, 'PreToolUse')) {
    if (filteredPreToolUse.length === 0) {
      delete hooks.PreToolUse
    } else {
      hooks.PreToolUse = filteredPreToolUse
    }
  }
  removeEmptyHookConfigEntries(hooksConfig)
  writeJson(hooksPath, hooksConfig)

  return removedModernHooks
    ? '.codex/hooks.json -> UserPromptSubmit hook removed'
    : '.codex/hooks.json -> PreToolUse hook removed'
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
  const environment = existingServer && isRecord(existingServer.environment)
    ? { ...existingServer.environment }
    : {}
  delete environment.MADAR_TOOL_PROFILE
  const serverConfig: Record<string, unknown> = {
    type: 'local',
    command: [process.execPath, resolvePackageCliPath(packageRoot), 'serve', '--stdio', '--auto-refresh'],
    ...(Object.keys(environment).length > 0 ? { environment } : {}),
    enabled: true,
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

export function installSkill(platform: SkillInstallPlatform, options: InstallSkillOptions = {}): string {
  const homeDir = resolve(options.homeDir ?? homedir())
  const packageRoot = resolve(options.packageRoot ?? findPackageRoot())
  const version = options.version ?? readPackageVersion(packageRoot)
  const skillContent = resolveSkillContent(platform)
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

export function geminiInstall(projectDir = '.', options: InstallSkillOptions = {}): string {
  const resolvedProjectDir = resolve(projectDir)
  const messages = [
    installSkill('gemini', options),
    writeSection(join(resolvedProjectDir, 'GEMINI.md'), geminiMdSection()),
    installGeminiHook(resolvedProjectDir),
    installMcpServer(resolvedProjectDir, 'gemini'),
    '',
    'Gemini CLI will now call Madar retrieve before broad repository search.',
  ]
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
  const mcpMessage = uninstallMcpServer(resolvedProjectDir, 'gemini')
  if (mcpMessage) {
    messages.push(mcpMessage)
  }
  return messages.join('\n')
}

export function installCopilotMcp(projectDir = '.', packageRoot = findPackageRoot()): string {
  return installMcpServer(resolve(projectDir), 'copilot', resolve(packageRoot))
}

export function uninstallCopilotMcp(projectDir = '.'): string {
  return uninstallMcpServer(resolve(projectDir), 'copilot') ?? 'No madar Copilot MCP server found - nothing to do'
}

export function cursorInstall(projectDir = '.'): string {
  const resolvedProjectDir = resolve(projectDir)
  const rulePath = join(resolvedProjectDir, CURSOR_RULE_RELATIVE_PATH)
  ensureParentDirectory(rulePath)

  const messages: string[] = []
  const ruleContent = cursorRule()

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

  messages.push(installMcpServer(resolvedProjectDir, 'cursor'))
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

export function claudeInstall(projectDir = '.'): string {
  const resolvedProjectDir = resolve(projectDir)
  assertClaudePromptHookScriptIsSafe(resolvedProjectDir)
  const messages = [
    writeSection(join(resolvedProjectDir, 'CLAUDE.md'), claudeMdSection()),
    installClaudeHook(resolvedProjectDir),
    installMcpServer(resolvedProjectDir, 'claude'),
    '',
    'Claude Code will now call Madar retrieve before broad repository search.',
  ]
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
  if (platform === 'codex') {
    assertCodexPromptHookScriptIsSafe(resolvedProjectDir)
    assertCodexMcpConfigIsSafe(resolvedProjectDir)
  }
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
    messages.push(installCodexMcpServer(resolvedProjectDir))
  } else if (platform === 'opencode') {
    messages.push(...installOpencodePlugin(resolvedProjectDir))
    messages.push(installOpencodeMcpServer(resolvedProjectDir, packageRoot))
  }

  if (platform === 'codex') {
    messages.push('', 'Codex will now call Madar retrieve before broad repository search.', 'Uninstall with: madar codex uninstall')
  } else if (platform === 'aider') {
    messages.push('', 'Aider will now use the Madar retrieve guidance in AGENTS.md.', 'Uninstall with: madar aider uninstall')
  } else if (platform === 'opencode') {
    messages.push('', 'OpenCode will now call Madar retrieve before broad repository search.', 'Uninstall with: madar opencode uninstall')
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
  if (platform === 'codex') {
    assertCodexMcpConfigIsSafe(resolvedProjectDir)
  }
  const messages = [removeSectionFromFile(join(resolvedProjectDir, 'AGENTS.md'))]

  if (platform === 'codex') {
    const hookMessage = uninstallCodexHook(resolvedProjectDir)
    if (hookMessage) {
      messages.push(hookMessage)
    }
    const mcpMessage = uninstallCodexMcpServer(resolvedProjectDir)
    if (mcpMessage) {
      messages.push(mcpMessage)
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
