import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

function readText(path: string): string {
  return readFileSync(resolve(path), 'utf8')
}

const LEGACY_BRAND = ['g', 'r', 'a', 'p', 'h', 'i', 'f', 'y'].join('')

describe('thin delivery package surface', () => {
  it('ships only the Madar binary at the lazy adapter entrypoint', () => {
    const manifest = JSON.parse(readText('package.json')) as {
      name?: string
      bin?: Record<string, string>
      scripts?: Record<string, string>
    }

    expect(manifest.name).toBe('@lubab/madar')
    expect(manifest.bin).toEqual({
      madar: 'dist/src/adapters/cli/bin.js',
    })
    expect(Object.keys(manifest.scripts ?? {})).not.toEqual(
      expect.arrayContaining([
        'compat:prepare',
        'compat:pack:dry-run',
        'compat:publish:dry-run',
        'compat:publish:public',
      ]),
    )
    expect(JSON.stringify(manifest)).not.toContain(LEGACY_BRAND)
  })

  it('removes predecessor CLI and stdio modules instead of retaining facades', () => {
    const removedPaths = [
      'src/cli/bin.ts',
      'src/cli/main.ts',
      'src/cli/parser.ts',
      'src/runtime/stdio-server.ts',
      'src/runtime/stdio/definitions.ts',
      'src/runtime/stdio/resources.ts',
      'src/runtime/stdio/tools.ts',
    ]

    for (const path of removedPaths) {
      expect(existsSync(resolve(path)), path).toBe(false)
    }
    expect(existsSync(resolve('src/adapters/cli/bin.ts'))).toBe(true)
    expect(existsSync(resolve('src/adapters/cli/main.ts'))).toBe(true)
    expect(existsSync(resolve('src/adapters/mcp/protocol.ts'))).toBe(true)
    expect(existsSync(resolve('src/adapters/mcp/server.ts'))).toBe(true)
  })

  it('keeps the lightweight bin free of retired command and transport aliases', () => {
    const source = readText('src/adapters/cli/bin.ts')
    const retiredCommands = [
      'watch',
      'serve',
      'try',
      'benchmark',
      'bench:suite',
      'eval',
      'compare',
      'hook',
      'telemetry',
    ]
    const retiredFlags = [
      '--stdio',
      '--mcp',
      '--auto-refresh',
      '--neo4j-',
    ]

    for (const command of retiredCommands) {
      expect(source, command).not.toMatch(
        new RegExp(`\\n {2}${command.replace(':', '\\:')}(?:\\s|$)`),
      )
    }
    for (const flag of retiredFlags) {
      expect(source, flag).not.toContain(flag)
    }
    for (const command of [
      'generate',
      'query',
      'status',
      'doctor',
      'install',
      'mcp',
    ]) {
      expect(source).toContain(command)
    }
  })
})
