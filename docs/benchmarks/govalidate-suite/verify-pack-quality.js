#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function usage() {
  return [
    'Usage:',
    '  node docs/benchmarks/govalidate-suite/verify-pack-quality.js --report <report.json> (--gate <name> | --prompt <text>) [--config <quality-gates.json>]',
  ].join('\n')
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function parseArgs(argv) {
  const args = { report: null, gate: null, prompt: null, config: null }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = argv[index + 1]

    if (arg === '--report') {
      args.report = value ?? null
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

  if (!args.report) {
    fail(`Missing required --report argument.\n${usage()}`)
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

function normalizeLabel(label) {
  return label.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function validateGateDefinition(gateName, gate) {
  if (gate === null || typeof gate !== 'object' || Array.isArray(gate)) {
    fail(`Malformed gate definition for ${gateName}: expected an object`)
  }

  const requiredLabels = gate.required_labels
  const forbiddenLabels = gate.forbidden_labels
  const maxPackTokens = gate.max_pack_tokens
  const maxMatchedNodes = gate.max_matched_nodes
  const maxRelationships = gate.max_relationships

  if (!Array.isArray(requiredLabels) || requiredLabels.length === 0 || requiredLabels.some((label) => typeof label !== 'string' || label.trim() === '')) {
    fail(`Malformed gate definition for ${gateName}: required_labels must be a non-empty string array`)
  }
  if (!Array.isArray(forbiddenLabels) || forbiddenLabels.some((label) => typeof label !== 'string' || label.trim() === '')) {
    fail(`Malformed gate definition for ${gateName}: forbidden_labels must be a string array`)
  }
  if ([...requiredLabels, ...forbiddenLabels].some((label) => normalizeLabel(label).length === 0)) {
    fail(`Malformed gate definition for ${gateName}: labels must contain at least one alphanumeric character after normalization`)
  }
  if (!Number.isFinite(maxPackTokens) || maxPackTokens <= 0) {
    fail(`Malformed gate definition for ${gateName}: max_pack_tokens must be a positive number`)
  }
  if (!Number.isInteger(maxMatchedNodes) || maxMatchedNodes <= 0) {
    fail(`Malformed gate definition for ${gateName}: max_matched_nodes must be a positive integer`)
  }
  if (!Number.isInteger(maxRelationships) || maxRelationships < 0) {
    fail(`Malformed gate definition for ${gateName}: max_relationships must be a non-negative integer`)
  }
  if ('prompt' in gate && (typeof gate.prompt !== 'string' || gate.prompt.trim() === '')) {
    fail(`Malformed gate definition for ${gateName}: prompt must be a non-empty string when provided`)
  }

  return {
    prompt: typeof gate.prompt === 'string' ? gate.prompt : null,
    required_labels: requiredLabels,
    forbidden_labels: forbiddenLabels,
    max_pack_tokens: maxPackTokens,
    max_matched_nodes: maxMatchedNodes,
    max_relationships: maxRelationships,
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

function validateReport(reportPath) {
  const report = readJsonFile(reportPath, 'compare report')
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    fail(`Malformed compare report: expected an object at ${reportPath}`)
  }
  if (report.pack === null || typeof report.pack !== 'object' || Array.isArray(report.pack)) {
    fail(`Malformed compare report: missing object report.pack in ${reportPath}`)
  }

  const { pack } = report
  if (!Number.isFinite(pack.token_count)) {
    fail(`Malformed compare report: pack.token_count must be a finite number`)
  }
  if (!Array.isArray(pack.matched_nodes)) {
    fail(`Malformed compare report: pack.matched_nodes must be an array`)
  }
  if (!Array.isArray(pack.relationships)) {
    fail(`Malformed compare report: pack.relationships must be an array`)
  }
  for (const [index, node] of pack.matched_nodes.entries()) {
    if (node === null || typeof node !== 'object' || Array.isArray(node) || typeof node.label !== 'string' || node.label.trim() === '') {
      fail(`Malformed compare report: pack.matched_nodes[${index}] must be an object with a non-empty label`)
    }
  }

  return report
}

function verifyPackQuality(gateName, gate, report) {
  const normalizedLabels = new Set(
    report.pack.matched_nodes
      .map((node) => normalizeLabel(node.label))
      .filter((label) => label.length > 0),
  )

  const missingRequired = gate.required_labels.filter((label) => !normalizedLabels.has(normalizeLabel(label)))
  const forbiddenPresent = gate.forbidden_labels.filter((label) => normalizedLabels.has(normalizeLabel(label)))
  const failures = []

  if (missingRequired.length > 0) {
    failures.push(`missing required labels: ${missingRequired.join(', ')}`)
  }
  if (forbiddenPresent.length > 0) {
    failures.push(`forbidden labels present: ${forbiddenPresent.join(', ')}`)
  }
  if (report.pack.token_count > gate.max_pack_tokens) {
    failures.push(`pack.token_count ${report.pack.token_count} exceeds max_pack_tokens ${gate.max_pack_tokens}`)
  }
  if (report.pack.matched_nodes.length > gate.max_matched_nodes) {
    failures.push(`pack.matched_nodes count ${report.pack.matched_nodes.length} exceeds max_matched_nodes ${gate.max_matched_nodes}`)
  }
  if (report.pack.relationships.length > gate.max_relationships) {
    failures.push(`pack.relationships count ${report.pack.relationships.length} exceeds max_relationships ${gate.max_relationships}`)
  }

  const lines = [
    `${gateName} ${failures.length === 0 ? 'PASS' : 'FAIL'}`,
    `prompt: ${gate.prompt ?? report.pack.question ?? report.question ?? '(unknown)'}`,
  ]

  if (failures.length === 0) {
    lines.push(`required labels present: ${gate.required_labels.join(', ')}`)
    lines.push('forbidden labels present: none')
    lines.push(`pack.token_count ${report.pack.token_count} <= max_pack_tokens ${gate.max_pack_tokens}`)
    lines.push(`pack.matched_nodes count ${report.pack.matched_nodes.length} <= max_matched_nodes ${gate.max_matched_nodes}`)
    lines.push(`pack.relationships count ${report.pack.relationships.length} <= max_relationships ${gate.max_relationships}`)
  } else {
    lines.push(...failures)
  }

  return { ok: failures.length === 0, output: lines.join('\n') }
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const args = parseArgs(process.argv.slice(2))
const configPath = args.config && isAbsolute(args.config)
  ? resolve(args.config)
  : resolve(scriptDir, args.config ?? 'quality-gates.json')
const reportPath = resolve(args.report)
const gates = loadGateConfig(configPath)
const { gateName, gate } = resolveGate(gates, args)
const report = validateReport(reportPath)
const result = verifyPackQuality(gateName, gate, report)

if (result.ok) {
  console.log(result.output)
  process.exit(0)
}

console.error(result.output)
process.exit(1)
