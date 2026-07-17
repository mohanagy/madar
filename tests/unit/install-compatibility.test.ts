import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  INSTALL_PLATFORMS,
  agentsInstall,
  claudeInstall,
  cursorInstall,
  geminiInstall,
  installCopilotMcp,
  installSkill,
  resolveCodexMcpConfigPath,
} from '../../src/infrastructure/install.js'

const PACKAGE_CLI_RELATIVE_PATH = join('dist', 'src', 'cli', 'bin.js')

type InstallPlatform = typeof INSTALL_PLATFORMS[number]

interface CompatibilityRow {
  platform: InstallPlatform
  label: string
  command: string
  docArtifacts: readonly string[]
  verify: string
  surface: string
  profile: string
  limitation: string
}

type HomeSkillPlatform = Exclude<InstallPlatform, 'cursor' | 'gemini'>
const PRIMARY_QUICKSTART_PLATFORMS = new Set<InstallPlatform>([
  'claude',
  'cursor',
  'copilot',
  'gemini',
  'aider',
  'codex',
  'opencode',
])

const DEDICATED_COMMAND_ROWS: CompatibilityRow[] = [
  {
    platform: 'claude',
    label: 'Claude Code',
    command: '`madar claude install [--profile core\\|full\\|strict]`',
    docArtifacts: ['`CLAUDE.md`', '`.claude/settings.json`', '`.mcp.json`'],
    verify: '`madar doctor` / `madar status`',
    surface: 'MCP tools, prompts, and resources via the selected tool profile.',
    profile: '`core`, `full`, and `strict`; strict exposes only `context_pack` and `context_expand` for one bounded context-pack-first pass.',
    limitation: 'The `UserPromptSubmit` hook only injects guidance for local code tasks.',
  },
  {
    platform: 'cursor',
    label: 'Cursor',
    command: '`madar cursor install [--profile core\\|full\\|strict]`',
    docArtifacts: ['`.cursor/rules/madar.mdc`', '`.cursor/mcp.json`'],
    verify: '`madar doctor` / `madar status`',
    surface: 'MCP tools, prompts, and resources via the selected tool profile.',
    profile: '`core`, `full`, and `strict`; strict exposes only `context_pack` and `context_expand` for one bounded context-pack-first pass.',
    limitation: 'Cursor has no separate prompt hook; the rule file plus MCP config are the managed surface.',
  },
  {
    platform: 'gemini',
    label: 'Gemini CLI',
    command: '`madar gemini install [--profile core\\|full\\|strict]`',
    docArtifacts: ['`~/.gemini/skills/madar/SKILL.md`', '`GEMINI.md`', '`.gemini/settings.json` hook and MCP entry'],
    verify: '`madar doctor` / `madar status` for `.gemini/settings.json`, then inspect the installed home skill for slash-command availability.',
    surface: 'Home skill, local instructions, and an installed MCP server using the selected tool profile.',
    profile: '`core`, `full`, and `strict`; strict exposes only `context_pack` and `context_expand` for one bounded context-pack-first pass.',
    limitation: 'Use `madar prompt --provider gemini` when you need a one-shot export instead of live MCP.',
  },
  {
    platform: 'copilot',
    label: 'GitHub Copilot CLI',
    command: '`madar copilot install [--profile core\\|full\\|strict]`',
    docArtifacts: ['`~/.copilot/skills/madar/SKILL.md`', '`.vscode/mcp.json`'],
    verify: '`madar doctor` / `madar status` for `.vscode/mcp.json`, then inspect the installed home skill for slash-command availability.',
    surface: 'Home skill plus MCP tools, prompts, and resources via the selected tool profile.',
    profile: '`core`, `full`, and `strict`; strict exposes only `context_pack` and `context_expand` for one bounded context-pack-first pass.',
    limitation: 'The repo-local verifier checks the MCP wiring; the home skill is a separate install surface.',
  },
  {
    platform: 'aider',
    label: 'Aider',
    command: '`madar aider install`',
    docArtifacts: ['`AGENTS.md`'],
    verify: '`madar doctor` / `madar status`',
    surface: 'Installed instructions only; use `madar pack` or `madar prompt` for portable context.',
    profile: 'Context-pack-first profile only.',
    limitation: 'Aider has no PreToolUse-style hook equivalent.',
  },
  {
    platform: 'codex',
    label: 'Codex CLI',
    command: '`madar codex install`',
    docArtifacts: ['`AGENTS.md`', '`.codex/hooks.json`', '`.codex/madar-user-prompt-submit.cjs`', '`~/.codex/config.toml`'],
    verify: '`madar doctor` / `madar status`',
    surface: 'Installed instructions, a task-applicable `UserPromptSubmit` hook, and a workspace-scoped MCP entry Codex CLI loads.',
    profile: 'Context-pack-first guidance with the strict MCP surface.',
    limitation: '`madar doctor` / `madar status` validate on-disk wiring only, not Codex live hook trust or MCP activation.',
  },
  {
    platform: 'opencode',
    label: 'OpenCode',
    command: '`madar opencode install`',
    docArtifacts: ['`AGENTS.md`', '`.opencode/plugins/madar.js`', '`opencode.json` or `opencode.jsonc`'],
    verify: '`madar doctor` / `madar status`',
    surface: 'Installed instructions, plugin wiring, and a local MCP entry for the Madar server.',
    profile: 'Context-pack-first guidance with the strict MCP surface.',
    limitation: 'Verification expects the Madar-owned plugin and `mcp.madar` entry to stay intact.',
  },
  {
    platform: 'claw',
    label: 'Claw',
    command: '`madar claw install`',
    docArtifacts: ['`AGENTS.md`'],
    verify: 'Inspect the generated `AGENTS.md` profile.',
    surface: 'Installed instructions only; use `madar pack` or `madar prompt` for portable context.',
    profile: 'Context-pack-first profile only.',
    limitation: 'There is no repo-local MCP or doctor/status integration for Claw.',
  },
  {
    platform: 'droid',
    label: 'Factory Droid',
    command: '`madar droid install`',
    docArtifacts: ['`AGENTS.md`'],
    verify: 'Inspect the generated `AGENTS.md` profile.',
    surface: 'Installed instructions only; use `madar pack` or `madar prompt` for portable context.',
    profile: 'Context-pack-first profile only.',
    limitation: 'There is no repo-local MCP or doctor/status integration for Factory Droid.',
  },
  {
    platform: 'trae',
    label: 'Trae',
    command: '`madar trae install`',
    docArtifacts: ['`AGENTS.md`'],
    verify: 'Inspect the generated `AGENTS.md` profile.',
    surface: 'Installed instructions only; use `madar pack` or `madar prompt` for portable context.',
    profile: 'Context-pack-first profile only.',
    limitation: 'There is no repo-local MCP or doctor/status integration for Trae.',
  },
  {
    platform: 'trae-cn',
    label: 'Trae CN',
    command: '`madar trae-cn install`',
    docArtifacts: ['`AGENTS.md`'],
    verify: 'Inspect the generated `AGENTS.md` profile.',
    surface: 'Installed instructions only; use `madar pack` or `madar prompt` for portable context.',
    profile: 'Context-pack-first profile only.',
    limitation: 'There is no repo-local MCP or doctor/status integration for Trae CN.',
  },
]

const INSTALL_COMMAND_ROWS: CompatibilityRow[] = [
  {
    platform: 'claude',
    label: 'Claude Code skill install',
    command: '`madar install --platform claude`',
    docArtifacts: ['`~/.claude/skills/madar/SKILL.md`', '`~/.claude/CLAUDE.md`'],
    verify: 'Inspect `SKILL.md` and the sibling `.madar_version` marker.',
    surface: 'Bundled home skill only.',
    profile: 'Home skill install; no repo-local MCP wiring is added.',
    limitation: 'Use `madar claude install` inside each repo for `CLAUDE.md`, hooks, and `.mcp.json`.',
  },
  {
    platform: 'gemini',
    label: 'Gemini CLI alias install',
    command: '`madar install --platform gemini`',
    docArtifacts: ['`~/.gemini/skills/madar/SKILL.md`', '`GEMINI.md`', '`.gemini/settings.json`'],
    verify: '`madar doctor` / `madar status` for `.gemini/settings.json`, then inspect the installed home skill for slash-command availability.',
    surface: 'Alias for the dedicated Gemini installer, including its home skill and project-local files.',
    profile: 'Uses the dedicated Gemini installer with its default profile; `madar install` does not accept `--profile`.',
    limitation: 'Use `madar gemini install --profile ...` when you need to choose `core`, `full`, or `strict` explicitly.',
  },
  {
    platform: 'cursor',
    label: 'Cursor alias install',
    command: '`madar install --platform cursor`',
    docArtifacts: ['`.cursor/rules/madar.mdc`', '`.cursor/mcp.json`'],
    verify: '`madar doctor` / `madar status`',
    surface: 'Alias for the project-local Cursor installer.',
    profile: 'Uses the dedicated Cursor installer with its default profile; `madar install` does not accept `--profile`.',
    limitation: 'Use `madar cursor install --profile ...` when you need to choose `core`, `full`, or `strict` explicitly.',
  },
  {
    platform: 'copilot',
    label: 'GitHub Copilot CLI skill install',
    command: '`madar install --platform copilot`',
    docArtifacts: ['`~/.copilot/skills/madar/SKILL.md`'],
    verify: 'Inspect `SKILL.md` and the sibling `.madar_version` marker.',
    surface: 'Bundled home skill only.',
    profile: 'Home skill install; no repo-local `.vscode/mcp.json` wiring is added.',
    limitation: 'Use `madar copilot install` when you also want the repo-local MCP config.',
  },
  {
    platform: 'aider',
    label: 'Aider skill install',
    command: '`madar install --platform aider`',
    docArtifacts: ['`~/.aider/madar/SKILL.md`'],
    verify: 'Inspect `SKILL.md` and the sibling `.madar_version` marker.',
    surface: 'Bundled home skill only.',
    profile: 'Home skill guidance only; no repo-local AGENTS.md changes are made.',
    limitation: 'Use `madar aider install` inside a repo when you want the project-local AGENTS profile.',
  },
  {
    platform: 'codex',
    label: 'Codex CLI skill install',
    command: '`madar install --platform codex`',
    docArtifacts: ['`~/.agents/skills/madar/SKILL.md`'],
    verify: 'Inspect `SKILL.md` and the sibling `.madar_version` marker.',
    surface: 'Bundled home skill only.',
    profile: 'Home skill guidance only; no repo-local AGENTS.md, hook, or MCP changes are made.',
    limitation: 'Use `madar codex install` inside a repo when you want the project-local AGENTS profile, `UserPromptSubmit` hook, and MCP entry.',
  },
  {
    platform: 'opencode',
    label: 'OpenCode skill install',
    command: '`madar install --platform opencode`',
    docArtifacts: ['`~/.config/opencode/skills/madar/SKILL.md`'],
    verify: 'Inspect `SKILL.md` and the sibling `.madar_version` marker.',
    surface: 'Bundled home skill only.',
    profile: 'Home skill guidance only; no repo-local plugin or MCP entry is added.',
    limitation: 'Use `madar opencode install` inside a repo when you want the project-local plugin and `mcp.madar` entry.',
  },
  {
    platform: 'claw',
    label: 'Claw skill install',
    command: '`madar install --platform claw`',
    docArtifacts: ['`~/.claw/skills/madar/SKILL.md`'],
    verify: 'Inspect `SKILL.md` and the sibling `.madar_version` marker.',
    surface: 'Bundled home skill only.',
    profile: 'Sequential-workflow skill guidance only.',
    limitation: 'There is no repo-local MCP or doctor/status integration for Claw.',
  },
  {
    platform: 'droid',
    label: 'Factory Droid skill install',
    command: '`madar install --platform droid`',
    docArtifacts: ['`~/.factory/skills/madar/SKILL.md`'],
    verify: 'Inspect `SKILL.md` and the sibling `.madar_version` marker.',
    surface: 'Bundled home skill only.',
    profile: 'Factory Droid skill guidance only.',
    limitation: 'There is no repo-local MCP or doctor/status integration for Factory Droid.',
  },
  {
    platform: 'trae',
    label: 'Trae skill install',
    command: '`madar install --platform trae`',
    docArtifacts: ['`~/.trae/skills/madar/SKILL.md`'],
    verify: 'Inspect `SKILL.md` and the sibling `.madar_version` marker.',
    surface: 'Bundled home skill only.',
    profile: 'Trae skill guidance only.',
    limitation: 'There is no repo-local MCP or doctor/status integration for Trae.',
  },
  {
    platform: 'trae-cn',
    label: 'Trae CN skill install',
    command: '`madar install --platform trae-cn`',
    docArtifacts: ['`~/.trae-cn/skills/madar/SKILL.md`'],
    verify: 'Inspect `SKILL.md` and the sibling `.madar_version` marker.',
    surface: 'Bundled home skill only.',
    profile: 'Trae CN skill guidance only.',
    limitation: 'There is no repo-local MCP or doctor/status integration for Trae CN.',
  },
  {
    platform: 'windows',
    label: 'Windows skill install',
    command: '`madar install --platform windows`',
    docArtifacts: ['`~/.claude/skills/madar/SKILL.md`'],
    verify: 'Inspect `SKILL.md` and the sibling `.madar_version` marker.',
    surface: 'Bundled home skill only.',
    profile: 'Windows terminal guidance only; it targets the Claude-style home skill directory.',
    limitation: 'There is no separate repo-local MCP wiring for the Windows skill install path.',
  },
]

function withTempDir(callback: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'madar-install-compat-'))
  try {
    callback(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function withBundledPackageRoot(callback: (packageRoot: string) => void): void {
  withTempDir((packageRoot) => {
    mkdirSync(join(packageRoot, 'assets', 'skills'), { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'madar-test', version: '0.1.0' }), 'utf8')

    for (const fileName of [
      'skill.md',
      'skill-aider.md',
      'skill-codex.md',
      'skill-copilot.md',
      'skill-opencode.md',
      'skill-claw.md',
      'skill-droid.md',
      'skill-trae.md',
      'skill-windows.md',
    ]) {
      writeFileSync(join(packageRoot, 'assets', 'skills', fileName), `# ${fileName}\n`, 'utf8')
    }

    callback(packageRoot)
  })
}

function withOpenCodePackageRoot(callback: (packageRoot: string) => void): void {
  withTempDir((packageRoot) => {
    const cliPath = join(packageRoot, PACKAGE_CLI_RELATIVE_PATH)
    mkdirSync(join(packageRoot, 'dist', 'src', 'cli'), { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'madar-test', bin: { madar: PACKAGE_CLI_RELATIVE_PATH } }), 'utf8')
    writeFileSync(cliPath, '#!/usr/bin/env node\n', 'utf8')
    callback(packageRoot)
  })
}

function expectArtifacts(rootDir: string, artifacts: readonly string[]): void {
  for (const artifact of artifacts) {
    expect(existsSync(join(rootDir, artifact))).toBe(true)
  }
}

function getHomeSkillArtifacts(platform: HomeSkillPlatform): string[] {
  switch (platform) {
    case 'claude':
      return ['.claude/skills/madar/SKILL.md', '.claude/CLAUDE.md']
    case 'copilot':
      return ['.copilot/skills/madar/SKILL.md']
    case 'aider':
      return ['.aider/madar/SKILL.md']
    case 'codex':
      return ['.agents/skills/madar/SKILL.md']
    case 'opencode':
      return ['.config/opencode/skills/madar/SKILL.md']
    case 'claw':
      return ['.claw/skills/madar/SKILL.md']
    case 'droid':
      return ['.factory/skills/madar/SKILL.md']
    case 'trae':
      return ['.trae/skills/madar/SKILL.md']
    case 'trae-cn':
      return ['.trae-cn/skills/madar/SKILL.md']
    case 'windows':
      return ['.claude/skills/madar/SKILL.md']
  }
}

describe('install compatibility guide', () => {
  it('documents every current install platform from the CLI contract', () => {
    const documentedPlatforms = new Set([
      ...DEDICATED_COMMAND_ROWS.map((row) => row.platform),
      ...INSTALL_COMMAND_ROWS.map((row) => row.platform),
    ])

    expect(new Set(INSTALL_PLATFORMS)).toEqual(documentedPlatforms)
  })

  it('keeps README agent setup discoverable through quickstarts and the CLI reference while the CLI reference links the compatibility guide', () => {
    const readme = readFileSync(resolve('README.md'), 'utf8')
    const reference = readFileSync(resolve('docs/reference/cli-and-mcp.md'), 'utf8')

    expect(readme).toContain('docs/tutorials/agent-quickstarts.md')
    expect(readme).toContain('docs/reference/cli-and-mcp.md')
    expect(reference).toContain('compatibility guide')
    expect(reference).toContain('../integrations/compatibility.md')
  })

  it('publishes verified quickstarts and smoke tests for the primary agent targets', () => {
    const readme = readFileSync(resolve('README.md'), 'utf8')
    const quickstarts = readFileSync(resolve('docs/tutorials/agent-quickstarts.md'), 'utf8')

    expect(readme).toContain('docs/tutorials/agent-quickstarts.md')
    expect(quickstarts).toContain('# Agent quickstarts')
    expect(quickstarts).toContain('madar try')
    expect(quickstarts).toContain('docs/tutorials/getting-started.md')
    expect(quickstarts).toContain('Smoke test')
    expect(quickstarts).toContain('Common failure modes')
    expect(quickstarts).toContain('not a supported quickstart')
    expect(quickstarts).toContain('instruction-only')

    for (const row of DEDICATED_COMMAND_ROWS.filter((candidate) => PRIMARY_QUICKSTART_PLATFORMS.has(candidate.platform))) {
      for (const expected of [row.label, row.command, ...row.docArtifacts, row.verify, row.limitation]) {
        expect(quickstarts).toContain(expected)
      }
    }
  })

  it('covers the documented install commands, artifacts, verification paths, profiles, and limitations', () => {
    const compatibilityGuide = readFileSync(resolve('docs/integrations/compatibility.md'), 'utf8')

    expect(compatibilityGuide).toContain('## Dedicated project install commands')
    expect(compatibilityGuide).toContain('## `madar install --platform ...` compatibility')
    expect(compatibilityGuide).toContain('Every home-skill install writes `SKILL.md` plus a sibling `.madar_version` marker.')

    for (const row of [...DEDICATED_COMMAND_ROWS, ...INSTALL_COMMAND_ROWS]) {
      for (const expected of [row.label, row.command, ...row.docArtifacts, row.verify, row.surface, row.profile, row.limitation]) {
        expect(compatibilityGuide).toContain(expected)
      }
    }
  })
})

describe('install compatibility artifacts', () => {
  it('matches the documented dedicated install outputs', () => {
    withBundledPackageRoot((bundledPackageRoot) => {
      withOpenCodePackageRoot((openCodePackageRoot) => {
        withTempDir((homeDir) => {
          for (const row of DEDICATED_COMMAND_ROWS) {
            withTempDir((projectDir) => {
              if (row.platform === 'claude') {
                claudeInstall(projectDir)
                expectArtifacts(projectDir, ['CLAUDE.md', '.claude/settings.json', '.mcp.json'])
                return
              }

              if (row.platform === 'cursor') {
                cursorInstall(projectDir)
                expectArtifacts(projectDir, ['.cursor/rules/madar.mdc', '.cursor/mcp.json'])
                return
              }

              if (row.platform === 'gemini') {
                geminiInstall(projectDir, { homeDir, packageRoot: bundledPackageRoot, version: 'test-version' })
                expectArtifacts(homeDir, ['.gemini/skills/madar/SKILL.md'])
                expectArtifacts(projectDir, ['GEMINI.md', '.gemini/settings.json'])
                return
              }

              if (row.platform === 'copilot') {
                installSkill('copilot', { homeDir, packageRoot: bundledPackageRoot, version: 'test-version' })
                installCopilotMcp(projectDir, {}, openCodePackageRoot)
                expectArtifacts(homeDir, ['.copilot/skills/madar/SKILL.md'])
                expectArtifacts(projectDir, ['.vscode/mcp.json'])
                return
              }

              if (row.platform === 'aider') {
                agentsInstall(projectDir, 'aider')
                expectArtifacts(projectDir, ['AGENTS.md'])
                return
              }

              if (row.platform === 'codex') {
                agentsInstall(projectDir, 'codex')
                expectArtifacts(projectDir, ['AGENTS.md', '.codex/hooks.json', '.codex/madar-user-prompt-submit.cjs'])
                expect(existsSync(resolveCodexMcpConfigPath())).toBe(true)
                return
              }

              if (row.platform === 'claw' || row.platform === 'droid' || row.platform === 'trae' || row.platform === 'trae-cn') {
                agentsInstall(projectDir, row.platform)
                expectArtifacts(projectDir, ['AGENTS.md'])
                return
              }

              agentsInstall(projectDir, 'opencode', { packageRoot: openCodePackageRoot })
              expectArtifacts(projectDir, ['AGENTS.md', '.opencode/plugins/madar.js', 'opencode.json'])
            })
          }
        })
      })
    })
  })

  it('matches the documented madar install --platform outputs', () => {
    withBundledPackageRoot((bundledPackageRoot) => {
      withTempDir((homeDir) => {
        for (const row of INSTALL_COMMAND_ROWS) {
          withTempDir((projectDir) => {
            if (row.platform === 'gemini') {
              geminiInstall(projectDir, { homeDir, packageRoot: bundledPackageRoot, version: 'test-version' })
              expectArtifacts(homeDir, ['.gemini/skills/madar/SKILL.md'])
              expectArtifacts(projectDir, ['GEMINI.md', '.gemini/settings.json'])
              return
            }

            if (row.platform === 'cursor') {
              cursorInstall(projectDir)
              expectArtifacts(projectDir, ['.cursor/rules/madar.mdc', '.cursor/mcp.json'])
              return
            }

            installSkill(row.platform, { homeDir, packageRoot: bundledPackageRoot, version: 'test-version' })

            expectArtifacts(homeDir, getHomeSkillArtifacts(row.platform))
          })
        }
      })
    })
  })
})
