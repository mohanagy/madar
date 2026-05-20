#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function usage() {
  return [
    'Usage:',
    '  node docs/benchmarks/govalidate-suite/verify-answer-quality.js --answer <answer.txt> (--gate <name> | --prompt <text>) [--config <quality-gates.json>]',
  ].join('\n')
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function parseArgs(argv) {
  const args = { answer: null, gate: null, prompt: null, config: null }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = argv[index + 1]

    if (arg === '--answer') {
      args.answer = value ?? null
      index += 1
      continue
    }
    if (arg === '--gate') {
      args.gate = value ?? null
      index += 1
      continue
    }
    if (arg === '--prompt') {
      args.prompt = value ?? null
      index += 1
      continue
    }
    if (arg === '--config') {
      args.config = value ?? null
      index += 1
      continue
    }
    fail(`Unknown argument: ${arg}\n${usage()}`)
  }

  if (!args.answer) {
    fail(`Missing required --answer argument.\n${usage()}`)
  }
  if ((args.gate ? 1 : 0) + (args.prompt ? 1 : 0) !== 1) {
    fail(`Pass exactly one of --gate or --prompt.\n${usage()}`)
  }

  return args
}

function readJsonFile(path, label) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    fail(`Failed to read ${label}: ${path}\n${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    return JSON.parse(raw)
  } catch (error) {
    fail(`Failed to parse ${label}: ${path}\n${error instanceof Error ? error.message : String(error)}`)
  }
}

function readTextFile(path, label) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    fail(`Failed to read ${label}: ${path}\n${error instanceof Error ? error.message : String(error)}`)
  }
}

function normalizeText(value) {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

function validateStringArray(gateName, fieldName, value, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || normalizeText(entry).length === 0)) {
    fail(`Malformed gate definition for ${gateName}: ${fieldName} must be a string array`)
  }
  if (!allowEmpty && value.length === 0) {
    fail(`Malformed gate definition for ${gateName}: ${fieldName} must be a non-empty string array`)
  }
  return value.map((entry) => entry.trim())
}

function validateGateDefinition(gateName, gate) {
  if (gate === null || typeof gate !== 'object' || Array.isArray(gate)) {
    fail(`Malformed gate definition for ${gateName}: expected an object`)
  }

  if (typeof gate.prompt !== 'string' || gate.prompt.trim() === '') {
    fail(`Malformed gate definition for ${gateName}: prompt must be a non-empty string`)
  }

  return {
    prompt: gate.prompt.trim(),
    required_answer_terms: validateStringArray(gateName, 'required_answer_terms', gate.required_answer_terms),
    forbidden_answer_terms: validateStringArray(gateName, 'forbidden_answer_terms', gate.forbidden_answer_terms, { allowEmpty: true }),
    required_concepts: validateStringArray(gateName, 'required_concepts', gate.required_concepts),
    answer_quality_notes: validateStringArray(gateName, 'answer_quality_notes', gate.answer_quality_notes),
    manual_review_notes: validateStringArray(gateName, 'manual_review_notes', gate.manual_review_notes),
  }
}

function loadGateConfig(configPath) {
  const parsed = readJsonFile(configPath, 'gate config')
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`Malformed gate config: expected a JSON object at ${configPath}`)
  }

  const entries = Object.entries(parsed)
  if (entries.length === 0) {
    fail(`Malformed gate config: expected at least one gate entry in ${configPath}`)
  }

  return new Map(entries.map(([gateName, gate]) => [gateName, validateGateDefinition(gateName, gate)]))
}

function resolveGate(gates, selector) {
  if (selector.gate) {
    const gate = gates.get(selector.gate)
    if (!gate) {
      fail(`Unknown gate: ${selector.gate}`)
    }
    return { gateName: selector.gate, gate }
  }

  const matches = [...gates.entries()].filter(([gateName, gate]) => gateName === selector.prompt || gate.prompt === selector.prompt)
  if (matches.length === 0) {
    fail(`No gate matches prompt: ${selector.prompt}`)
  }
  if (matches.length > 1) {
    fail(`Prompt matches multiple gates: ${selector.prompt}`)
  }

  const [gateName, gate] = matches[0]
  return { gateName, gate }
}

function verifyAnswerQuality(gateName, gate, answerText) {
  const normalizedAnswer = normalizeText(answerText)
  const missingRequired = gate.required_answer_terms.filter((term) => !normalizedAnswer.includes(normalizeText(term)))
  const forbiddenPresent = gate.forbidden_answer_terms.filter((term) => normalizedAnswer.includes(normalizeText(term)))
  const failures = []

  if (missingRequired.length > 0) {
    failures.push(`missing required answer terms: ${missingRequired.join(', ')}`)
  }
  if (forbiddenPresent.length > 0) {
    failures.push(`forbidden answer terms present: ${forbiddenPresent.join(', ')}`)
  }

  const lines = [
    `${gateName} ${failures.length === 0 ? 'PASS' : 'FAIL'}`,
    `prompt: ${gate.prompt}`,
  ]

  if (failures.length === 0) {
    lines.push(`required answer terms present: ${gate.required_answer_terms.join(', ')}`)
    lines.push('forbidden answer terms present: none')
  } else {
    lines.push(...failures)
  }

  lines.push(`required concepts (manual review): ${gate.required_concepts.join(', ')}`)
  lines.push(`answer quality notes: ${gate.answer_quality_notes.join(', ')}`)
  lines.push(`manual review notes: ${gate.manual_review_notes.join(', ')}`)

  return { ok: failures.length === 0, output: lines.join('\n') }
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const args = parseArgs(process.argv.slice(2))
const configPath = args.config ? resolve(args.config) : resolve(scriptDir, 'quality-gates.json')
const answerPath = resolve(args.answer)
const answerText = readTextFile(answerPath, 'answer artifact')
const gates = loadGateConfig(configPath)
const { gateName, gate } = resolveGate(gates, args)
const result = verifyAnswerQuality(gateName, gate, answerText)

if (result.ok) {
  console.log(result.output)
  process.exit(0)
}

console.error(result.output)
process.exit(1)
