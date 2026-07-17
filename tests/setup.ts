import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Project installers are allowed to update Codex's real global configuration.
// Keep unit tests hermetic while exercising that production path. A stable
// per-process path prevents parallel test-file setup from replacing another
// file's global config path while its assertions are running.
const testCodexHome = join(tmpdir(), `madar-vitest-codex-home-${process.pid}`)
mkdirSync(testCodexHome, { recursive: true })
process.env.CODEX_HOME = testCodexHome
