import { prepareWorkerHome } from './helpers/run-home.js'

// Project installers are allowed to update Codex's real global configuration.
// Keep unit tests hermetic while exercising that production path. A per-worker
// path prevents parallel test-file setup from replacing another file's global
// config path while its assertions are running.
//
// The directory now lives inside the run-owned root published by
// `tests/global-setup.ts`, so the run that created it is also the thing that
// removes it. Keying only on `process.pid`, as this once did, left every
// directory unowned: pids are recycled, so nothing could later tell a live
// worker's directory from a dead one's.
const { restore } = prepareWorkerHome()

// Belt and braces for the ordinary case. Global teardown removes the whole run
// root regardless; this lets a worker that exits cleanly tidy up immediately and
// restores `CODEX_HOME` to whatever the process had before.
process.on('exit', restore)
