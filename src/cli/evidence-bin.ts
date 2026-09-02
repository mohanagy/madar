#!/usr/bin/env node

import { resolve } from 'node:path'

import { serveEvidenceStdio } from '../runtime/evidence-stdio-server.js'

function usage(): string {
  return [
    'Madar interactive evidence prototype',
    '',
    'Usage:',
    '  node dist/src/cli/evidence-bin.js [--root <repository>] ',
    '',
    'Starts a read-only MCP stdio server exposing only:',
    '  resolve_anchor, search_exact, read_evidence, definition, references',
  ].join('\n')
}

function parseRoot(args: string[]): string {
  let root = process.cwd()
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--help' || argument === '-h') {
      process.stdout.write(`${usage()}\n`)
      process.exit(0)
    }
    if (argument === '--root') {
      const value = args[index + 1]
      if (!value) throw new Error('--root requires a directory path')
      root = value
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${argument ?? ''}`)
  }
  return resolve(root)
}

try {
  await serveEvidenceStdio({ rootDir: parseRoot(process.argv.slice(2)) })
} catch (error) {
  process.stderr.write(`[madar evidence] ${error instanceof Error ? error.message : 'startup failed'}\n`)
  process.exitCode = 1
}
