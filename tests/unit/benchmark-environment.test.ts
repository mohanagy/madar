import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  captureBenchmarkEnvironment,
  extractEnvironmentContamination,
} from '../../src/infrastructure/benchmark/environment.js'

async function withTempDir(callback: (tempDir: string) => Promise<void> | void): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), 'madar-benchmark-environment-'))
  try {
    await callback(tempDir)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

describe('benchmark environment helpers', () => {
  it('captures benchmark environment from project and Claude config roots', async () => {
    await withTempDir(async (tempDir) => {
      const claudeConfigDir = join(tempDir, '.claude')
      const projectParent = join(tempDir, 'workspace')
      const projectRoot = join(projectParent, 'repo')

      mkdirSync(join(claudeConfigDir, 'skills', 'brainstorming'), { recursive: true })
      mkdirSync(join(claudeConfigDir, '.agents', 'skills', 'systematic-debugging'), { recursive: true })
      mkdirSync(join(claudeConfigDir, '.cursor', 'skills', 'documentation-lookup'), { recursive: true })
      mkdirSync(join(claudeConfigDir, '.opencode', 'plugins'), { recursive: true })
      mkdirSync(join(projectRoot, '.claude'), { recursive: true })
      mkdirSync(join(projectRoot, '.vscode'), { recursive: true })
      mkdirSync(projectParent, { recursive: true })

      writeFileSync(join(claudeConfigDir, 'CLAUDE.md'), '# user claude\n', 'utf8')
      writeFileSync(join(projectParent, 'CLAUDE.md'), '# parent claude\n', 'utf8')
      writeFileSync(join(projectRoot, 'CLAUDE.md'), '# project claude\n', 'utf8')
      writeFileSync(join(claudeConfigDir, '.opencode', 'plugins', 'context7.ts'), 'export {}\n', 'utf8')
      writeFileSync(join(claudeConfigDir, '.opencode', 'plugins', 'team-hooks.ts'), 'export {}\n', 'utf8')
      writeFileSync(
        join(projectRoot, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            madar: { args: ['--stdio', 'out/graph.json'] },
            github: {},
            context7: {},
          },
        }, null, 2),
        'utf8',
      )
      writeFileSync(
        join(projectRoot, '.vscode', 'mcp.json'),
        JSON.stringify({
          servers: {
            sentry: {},
          },
        }, null, 2),
        'utf8',
      )
      writeFileSync(
        join(claudeConfigDir, 'settings.json'),
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [
              { hooks: [{ type: 'command', command: 'echo user-submit' }], matcher: 'prompt' },
            ],
            PostToolUse: [
              { hooks: [{ type: 'command', command: 'echo user-post' }], matcher: 'Read' },
            ],
          },
        }, null, 2),
        'utf8',
      )
      writeFileSync(
        join(projectRoot, '.claude', 'settings.json'),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              { matcher: 'Glob|Grep|Bash|Agent|Read', hooks: [{ type: 'command', command: 'echo project-pre' }] },
            ],
          },
        }, null, 2),
        'utf8',
      )

      const environment = await captureBenchmarkEnvironment({
        claudeConfigDir,
        getClaudeCodeVersion: () => '1.2.3',
        projectRoot,
      })

      expect(environment.claude_code_version).toBe('1.2.3')
      expect(environment.host_os).toMatch(/^(darwin|linux|win32)-/)
      expect(environment.node_version).toMatch(/^v\d+/)
      expect(environment.mcp_servers_active).toEqual(['context7', 'github', 'madar', 'sentry'])
      expect(environment.mcp_server_count).toBe(4)
      expect(environment.skills_loaded).toEqual([
        'brainstorming',
        'documentation-lookup',
        'systematic-debugging',
      ])
      expect(environment.skills_loaded_count).toBe(3)
      expect(environment.plugins_active).toEqual(['context7', 'team-hooks'])
      expect(environment.user_claude_md_hash).toMatch(/^sha256:/)
      expect(environment.project_claude_md_hash).toMatch(/^sha256:/)
      expect(environment.parent_claude_md_hashes).toHaveLength(1)
      expect(environment.hooks_active).toEqual({
        user_prompt_submit: ['user:command:prompt'],
        pre_tool_use: ['project:command:Glob|Grep|Bash|Agent|Read'],
        post_tool_use: ['user:command:Read'],
      })
    })
  })

  it('extracts contamination signals from synthetic verbose traces', () => {
    const contamination = extractEnvironmentContamination(JSON.stringify([
      {
        type: 'assistant',
        turn: 1,
        message: {
          content: [
            { type: 'text', text: '<command-name>superpowers:using-superpowers</command-name>' },
            { type: 'text', text: 'Skill tool invoked: {"skill":"superpowers:systematic-debugging"}' },
            { type: 'tool_use', name: 'mcp__madar__context_pack' },
          ],
        },
      },
      {
        type: 'assistant',
        turn: 2,
        message: {
          content: [
            { type: 'text', text: '<command-name>everything-claude-code:documentation-lookup</command-name>' },
            { type: 'text', text: 'spawn_agent worker launched' },
            { type: 'tool_use', name: 'mcp__github__search_code' },
            { type: 'tool_use', name: 'mcp__context7__get-library-docs' },
          ],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 34744,
        num_turns: 3,
        result: 'ok',
        total_cost_usd: 0.7,
        usage: {
          input_tokens: 13,
          cache_creation_input_tokens: 92833,
          cache_read_input_tokens: 140662,
          output_tokens: 1893,
        },
      },
    ]))

    expect(contamination).toEqual({
      skills_activated_during_run: [
        'everything-claude-code:documentation-lookup',
        'superpowers:systematic-debugging',
        'superpowers:using-superpowers',
      ],
      skills_conflicting_with_madar_rules: [
        'everything-claude-code:documentation-lookup',
        'superpowers:systematic-debugging',
      ],
      calls_to_other_mcps: {
        'mcp__context7__get-library-docs': 1,
        'mcp__github__search_code': 1,
      },
      subagent_dispatches_detected: 1,
      skill_alignment_score: 0.33,
    })
  })
})
