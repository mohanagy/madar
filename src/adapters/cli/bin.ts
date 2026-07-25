#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HELP = `Usage: madar <command>

Global options:
  --help       show this help
  --version    print the installed version

Commands:
  generate [path] [--update] [--watch] [generation options]
  query "<question>" [--graph PATH] [--budget N]
  status [graph.json]
  doctor [graph.json]
  install <claude|codex> [--uninstall]
  mcp
`

function installedVersion(): string {
  let directory = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth += 1) {
    const manifestPath = join(directory, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        name?: unknown
        version?: unknown
      }
      if (manifest.name === '@lubab/madar'
        && typeof manifest.version === 'string') {
        return manifest.version
      }
    }
    const parent = resolve(directory, '..')
    if (parent === directory) break
    directory = parent
  }
  throw new Error('Unable to locate the installed Madar package metadata')
}

const argv = process.argv.slice(2)
try {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--help')) {
    process.stdout.write(HELP)
  } else if (argv.length === 1 && argv[0] === '--version') {
    process.stdout.write(`${installedVersion()}\n`)
  } else {
    const { executeCli } = await import('./main.js')
    process.exitCode = await executeCli(argv, undefined, {
      version: installedVersion,
      cwd: process.cwd(),
    })
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message.startsWith('error:') ? message : `error: ${message}`}\n`)
  process.exitCode = 1
}
