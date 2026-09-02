// Thin wrapper retained for compatibility. The classification logic lives in
// arm-harness.mjs so the runner and the CI controls cannot drift apart.
import { readFileSync, writeFileSync } from 'node:fs'
import { summarizeEvents } from './arm-harness.mjs'

const input = process.argv[2]
const output = process.argv[3]
if (!input || !output) throw new Error('usage: summarize-events.mjs <events.jsonl> <summary.json>')

const lines = readFileSync(input, 'utf8').split(/\r?\n/).filter((line) => line.trim().length > 0)
writeFileSync(output, `${JSON.stringify(summarizeEvents(lines), null, 2)}\n`)
