import { afterEach, describe, expect, it, vi } from 'vitest'

import * as shell from '../../src/shared/shell.js'

describe('shared shell helpers', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('quotes Windows values for cmd.exe execution', () => {
    expect(shell.shellEscape('C:\\Users\\Jane Doe\\prompt.txt', 'win32')).toBe('"C:\\Users\\Jane Doe\\prompt.txt"')
    expect(shell.shellEscape("how's login work?", 'win32')).toBe("\"how's login work?\"")
  })

  it('selects cmd.exe for win32 shell execution', () => {
    vi.stubEnv('ComSpec', 'C:\\Windows\\System32\\cmd.exe')

    const resolveShellCommand = (shell as Record<string, unknown>).resolveShellCommand

    expect(typeof resolveShellCommand).toBe('function')
    expect((resolveShellCommand as (command: string, platform?: NodeJS.Platform) => unknown)('type "prompt.txt" | claude', 'win32')).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'type "prompt.txt" | claude'],
      useProcessGroup: false,
    })
  })

  it('selects /bin/sh for non-Windows shell execution', () => {
    const resolveShellCommand = (shell as Record<string, unknown>).resolveShellCommand

    expect(typeof resolveShellCommand).toBe('function')
    expect((resolveShellCommand as (command: string, platform?: NodeJS.Platform) => unknown)('cat prompt.txt | claude', 'linux')).toEqual({
      file: '/bin/sh',
      args: ['-lc', 'cat prompt.txt | claude'],
      useProcessGroup: true,
    })
  })
})
