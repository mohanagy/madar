import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { GRAPH_ARTIFACT_V2_TOMBSTONE } from '../../src/contracts/graph-artifact.js'
import { agentsInstall, claudeInstall, geminiInstall } from '../../src/infrastructure/install.js'
import {
  GENERATED_LEGACY_GRAPH_NOTICE,
  escapeGeneratedString,
  generatedGraphDiscoveryInline,
} from '../../src/shared/generated-graph-discovery.js'

/**
 * Every generated host surface must classify the workspace, not any one of them.
 *
 * Discovery existed in three separate copies -- the `node -e` tool-hook snippet,
 * the CommonJS prompt-hook script behind Claude Code's and Codex's
 * UserPromptSubmit hooks, and the ESM OpenCode plugin. Only the first was
 * migrated at the cutover. The prompt hook still gated on
 * `existsSync(out/graph.json)`, so a canonical-only workspace produced no
 * guidance while a mixed workspace produced the full "the graph is ready" text;
 * the OpenCode plugin accepted either file's existence, so a tombstone alone
 * looked ready.
 *
 * The reason none of that failed is that the previous matrix drove only
 * `geminiInstall`. This one drives every surface over the same states, so a
 * surface that is not migrated cannot pass by being untested.
 */

const VALID_V2 = 'MADAR_GRAPH_ARTIFACT/2\n{"nodes":[],"facts":[]}'
const LIVE_V1 = JSON.stringify({ schema_version: 1, directed: true, nodes: [{ id: 'a' }], links: [] })

interface WorkspaceFiles {
  readonly canonical?: string
  readonly legacy?: string
  readonly backup?: string
}

/** Ready, and whether the guidance has to name legacy compatibility. */
interface Expectation {
  readonly ready: boolean
  readonly legacy: boolean
}

/**
 * The full state table runs in process in host-discovery-states.test.ts, against
 * this same generator. Surfaces that have to be spawned to be observed use the
 * three states that distinguish their wiring -- ready, ready-but-legacy, and not
 * ready -- because one file spawning a process per state per host is enough to
 * starve the worker pool, and a timeout there reads as a failure of the contract
 * rather than of the machine.
 */
const SPAWNED_STATES: ReadonlyArray<readonly [string, WorkspaceFiles, Expectation]> = [
  ['current v2 with a tombstone', { canonical: VALID_V2, legacy: GRAPH_ARTIFACT_V2_TOMBSTONE }, { ready: true, legacy: false }],
  ['legacy v1 only', { legacy: LIVE_V1 }, { ready: true, legacy: true }],
  ['a tombstone alone', { legacy: GRAPH_ARTIFACT_V2_TOMBSTONE }, { ready: false, legacy: false }],
]

/** Evaluated in process, so the whole table is cheap here. */
const STATES: ReadonlyArray<readonly [string, WorkspaceFiles, Expectation]> = [
  ['current v2 with a tombstone', { canonical: VALID_V2, legacy: GRAPH_ARTIFACT_V2_TOMBSTONE }, { ready: true, legacy: false }],
  ['canonical only', { canonical: VALID_V2 }, { ready: true, legacy: false }],
  ['legacy v1 only', { legacy: LIVE_V1 }, { ready: true, legacy: true }],
  ['mixed v2 and live v1', { canonical: VALID_V2, legacy: LIVE_V1 }, { ready: false, legacy: false }],
  ['a tombstone alone', { legacy: GRAPH_ARTIFACT_V2_TOMBSTONE }, { ready: false, legacy: false }],
  ['a tombstone with a backup', { legacy: GRAPH_ARTIFACT_V2_TOMBSTONE, backup: LIVE_V1 }, { ready: false, legacy: false }],
  ['a corrupt canonical', { canonical: 'MADAR_NOT_AN_ARTIFACT', legacy: GRAPH_ARTIFACT_V2_TOMBSTONE }, { ready: false, legacy: false }],
  ['an empty workspace', {}, { ready: false, legacy: false }],
]

function workspace(files: WorkspaceFiles): string {
  const root = mkdtempSync(join(tmpdir(), 'host-surfaces-'))
  const out = join(root, 'out')
  mkdirSync(out, { recursive: true })
  if (files.canonical !== undefined) writeFileSync(join(out, 'graph.madar'), files.canonical)
  if (files.legacy !== undefined) writeFileSync(join(out, 'graph.json'), files.legacy)
  if (files.backup !== undefined) writeFileSync(join(out, 'graph.v1.json'), files.backup)
  return root
}


/** Package root carrying a stub CLI, so the installer never needs a built dist. */
function stubPackageRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'host-surfaces-pkg-'))
  // The bin entry uses the platform separator, as the installer's own resolver
  // does; a literal forward-slash value does not match on Windows.
  const relativeCliPath = join('dist', 'src', 'cli', 'bin.js')
  const cliPath = join(root, relativeCliPath)
  mkdirSync(join(cliPath, '..'), { recursive: true })
  writeFileSync(cliPath, '#!/usr/bin/env node\n')
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'madar-test',
    bin: { madar: relativeCliPath },
  }))
  return root
}

/** What a generated surface told the host: nothing, or some guidance text. */
interface Guidance {
  readonly emitted: boolean
  readonly text: string
}

/**
 * Runs a generated `node -e` tool hook, spawned directly rather than through a
 * shell.
 *
 * Going through `cmd /c` on Windows mangled the program before node saw it,
 * which measured the harness rather than the product. #705 changed the
 * generated program, so it is executed on every platform instead of recorded as
 * an unverified gap. Splitting on the double quote is safe because the
 * generator refuses to emit one; see escapeGeneratedString.
 */
function toolHookGuidance(root: string, command: string): Guidance {
  const nested = join(root, 'nested', 'session')
  mkdirSync(nested, { recursive: true })

  const parts = command.split('"')
  const program = parts[1]
  const payloads = parts.slice(2).map((part) => part.trim()).filter((part) => part.length > 0)
  if (typeof program !== 'string' || payloads.length === 0) {
    throw new Error(`could not split the generated command into a program and payloads: ${command.slice(0, 80)}`)
  }

  const result = spawnSync(process.execPath, ['-e', program, ...payloads], {
    cwd: nested,
    input: JSON.stringify({ tool_name: 'read_file' }),
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  if (typeof result.status !== 'number') {
    throw new Error(`hook did not run to completion: signal=${String(result.signal)}`)
  }
  if (result.status !== 0) {
    throw new Error(`hook exited ${result.status}: ${`${result.stderr ?? ''}`.slice(0, 200)}`)
  }
  const stdout = `${result.stdout ?? ''}`
  return { emitted: stdout.includes('additionalContext'), text: stdout }
}

/** Runs a generated CommonJS prompt-hook script with a codebase question. */
function promptHookGuidance(root: string, scriptPath: string): Guidance {
  const nested = join(root, 'nested', 'session')
  mkdirSync(nested, { recursive: true })
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: nested,
    input: JSON.stringify({ prompt: 'how does the authentication function in this repository work?' }),
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  if (typeof result.status !== 'number') {
    throw new Error(`prompt hook did not run to completion: signal=${String(result.signal)}`)
  }
  const stdout = `${result.stdout ?? ''}`
  return { emitted: stdout.includes('additionalContext'), text: stdout }
}

describe('every generated host surface classifies the workspace', () => {
  it.each(SPAWNED_STATES)('the Gemini tool hook reads %s correctly', (_label, files, expectation) => {
    const root = workspace(files as WorkspaceFiles)
    try {
      geminiInstall(root)
      const settings = JSON.parse(readFileSync(join(root, '.gemini', 'settings.json'), 'utf8')) as {
        hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
      }
      const command = settings.hooks?.BeforeTool?.[0]?.hooks?.[0]?.command ?? ''
      expect(command.length).toBeGreaterThan(0)

      const guidance = toolHookGuidance(root, command)

      expect(guidance.emitted).toBe(expectation.ready)
      if (expectation.legacy) {
        expect(guidance.text).toContain(GENERATED_LEGACY_GRAPH_NOTICE)
      } else if (guidance.emitted) {
        expect(guidance.text).not.toContain(GENERATED_LEGACY_GRAPH_NOTICE)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  it.each(SPAWNED_STATES)('the Claude prompt hook reads %s correctly', (_label, files, expectation) => {
    const root = workspace(files as WorkspaceFiles)
    try {
      claudeInstall(root)
      const scriptPath = join(root, '.claude', 'madar-user-prompt-submit.cjs')

      const guidance = promptHookGuidance(root, scriptPath)

      // This is the hook that never adopted classification: a canonical-only
      // workspace produced nothing and a mixed workspace produced everything.
      expect(guidance.emitted).toBe(expectation.ready)
      if (expectation.legacy) {
        expect(guidance.text).toContain('legacy out/graph.json')
      } else if (guidance.emitted) {
        expect(guidance.text).not.toContain('legacy out/graph.json')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  it.each(STATES)('the OpenCode plugin reads %s correctly', async (_label, files, expectation) => {
    const root = workspace(files as WorkspaceFiles)
    try {
      const packageRoot = stubPackageRoot()
      try {
        agentsInstall(root, 'opencode', { packageRoot })
      } finally {
        rmSync(packageRoot, { recursive: true, force: true })
      }
      const pluginSource = readFileSync(join(root, '.opencode', 'plugins', 'madar.js'), 'utf8')
      const body = pluginSource
        .replace(/^import .*$/gm, '')
        .replace('export const MadarPlugin', 'const MadarPlugin')
      // eslint-disable-next-line no-new-func
      const build = new Function('require', `
        const { closeSync, lstatSync, openSync, readSync } = require('fs');
        const { dirname: dirnameOf, join: joinPath } = require('path');
        ${body}
        return MadarPlugin`) as (requireFn: NodeRequire) => (input: { directory: string }) => Promise<{
          'tool.execute.before': (
            input: { tool: string },
            output: { args: { command: string } },
          ) => Promise<void>
        }>

      const handlers = await build(createRequire(import.meta.url))({ directory: root })
      const output = { args: { command: 'ls' } }
      await handlers['tool.execute.before']({ tool: 'bash' }, output)

      const reminded = output.args.command.includes('[madar]')
      expect(reminded).toBe(expectation.ready)
      if (expectation.legacy) {
        // An unqualified "Knowledge graph available" is what the contract bans
        // here: the graph is real but is being read in compatibility mode.
        expect(output.args.command).toContain(GENERATED_LEGACY_GRAPH_NOTICE)
      } else if (reminded) {
        expect(output.args.command).toContain('[madar] Knowledge graph available.')
        expect(output.args.command).not.toContain(GENERATED_LEGACY_GRAPH_NOTICE)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  it.each([
    ['graph.madar', "'graph.madar'"],
    ["it's", "'it\\'s'"],
    ['a\\b', "'a\\\\b'"],
    ['line\nbreak', "'line\\nbreak'"],
  ])('embeds %s as a safe single-quoted literal', (value, expected) => {
    // The inline form lives inside `node -e "<program>"`. Today's constants
    // happen to contain no apostrophe, but a rename that introduced one would
    // otherwise produce a truncated program with no test failing.
    expect(escapeGeneratedString(value)).toBe(expected)
  })

  it('emits no line comment in the inline form', () => {
    // The inline form is one line, so a `//` anywhere in it comments out the
    // rest of the program. A comment added inside the generated function did
    // exactly that and truncated the classifier at the finally block.
    const inline = generatedGraphDiscoveryInline()

    expect(inline).not.toContain('//')
    expect(inline.includes('\n')).toBe(false)
    expect(inline).toContain('classifyMadarWorkspace')
  })

  it('refuses to embed a value that would close the shell string', () => {
    // A double quote cannot be escaped out of trouble here: it ends the
    // `node -e "..."` argument itself, so generation has to fail instead.
    expect(() => escapeGeneratedString('say "hi"')).toThrow(/double quote/)
  })

  it('generates the classifier from one shared source, not a copy per host', () => {
    const root = workspace({ canonical: VALID_V2, legacy: GRAPH_ARTIFACT_V2_TOMBSTONE })
    try {
      geminiInstall(root)
      claudeInstall(root)
      const packageRoot = stubPackageRoot()
      try {
        agentsInstall(root, 'opencode', { packageRoot })
      } finally {
        rmSync(packageRoot, { recursive: true, force: true })
      }

      const settings = JSON.parse(readFileSync(join(root, '.gemini', 'settings.json'), 'utf8')) as {
        hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
      }
      const surfaces = [
        settings.hooks?.BeforeTool?.[0]?.hooks?.[0]?.command ?? '',
        readFileSync(join(root, '.claude', 'madar-user-prompt-submit.cjs'), 'utf8'),
        readFileSync(join(root, '.opencode', 'plugins', 'madar.js'), 'utf8'),
      ]

      // The function name is the seam. Three hosts naming it means three hosts
      // built from the same generator, which is what stops one from drifting.
      for (const surface of surfaces) {
        expect(surface).toContain('classifyMadarWorkspace')
        expect(surface).toContain('MADAR_GRAPH_ARTIFACT/2')
        expect(surface).toContain('MADAR_GRAPH_MOVED/')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})
