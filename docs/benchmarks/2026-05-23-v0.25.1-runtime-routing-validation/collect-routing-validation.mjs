#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '../../..')
const usage = 'Usage: node collect-routing-validation.mjs --graph /absolute/path/to/graph.json [--prompts prompts.json] [--output routing-validation.json] [--budget 4000]'

function parseArgs(argv) {
  const out = {
    graph: null,
    prompts: resolve(scriptDir, 'prompts.json'),
    output: resolve(scriptDir, 'routing-validation.json'),
    budget: 4000,
  }

  const readValue = (arg, next) => {
    if (typeof next !== 'string' || next.length === 0 || next.startsWith('-')) {
      throw new Error(`Missing value for ${arg}`)
    }
    return next
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === '--graph') {
      out.graph = readValue(arg, next)
      i += 1
    } else if (arg === '--prompts') {
      out.prompts = resolve(process.cwd(), readValue(arg, next))
      i += 1
    } else if (arg === '--output') {
      out.output = resolve(process.cwd(), readValue(arg, next))
      i += 1
    } else if (arg === '--budget') {
      const parsedBudget = Number(readValue(arg, next))
      if (!Number.isFinite(parsedBudget) || !Number.isInteger(parsedBudget) || parsedBudget <= 0) {
        throw new Error(`--budget must be a positive integer, received: ${next ?? ''}`)
      }
      out.budget = parsedBudget
      i += 1
    }
    else throw new Error(`Unknown argument: ${arg}`)
  }

  if (!out.graph) {
    throw new Error(`Missing required --graph.\n${usage}`)
  }

  out.graph = resolve(process.cwd(), out.graph)
  return out
}

function sanitizeSourceFile(sourceFile, workspaceRoot) {
  if (typeof sourceFile !== 'string' || sourceFile.length === 0) {
    return sourceFile
  }
  const absolute = resolve(workspaceRoot, sourceFile)
  const rel = relative(workspaceRoot, absolute)
  if (rel.startsWith('..')) {
    return isAbsolute(sourceFile) ? '<external-path>' : sourceFile.replaceAll('\\', '/')
  }
  return rel.replaceAll('\\', '/')
}

function inferActualDomain(targetDomainHint) {
  if (targetDomainHint === 'backend_runtime') return 'backend_runtime'
  if (targetDomainHint === 'frontend_display') return 'frontend_display'
  return 'ambiguous'
}

function runPack(cliPath, graphPath, budget, question) {
  const result = spawnSync(
    'node',
    [cliPath, 'pack', question, '--task', 'explain', '--graph', graphPath, '--budget', String(budget)],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
    },
  )

  if (result.status !== 0) {
    throw new Error(`pack failed for "${question}": ${result.stderr || result.stdout}`)
  }

  return JSON.parse(result.stdout)
}

function evaluatePrompt(prompt, payload) {
  const pack = payload.pack ?? {}
  const gate = payload.retrieval_gate ?? pack.retrieval_gate ?? {}
  const signals = gate.signals ?? {}
  const generationIntent = signals.generation_intent ?? 'unknown'
  const targetDomainHint = signals.target_domain_hint ?? 'unknown'
  const retrievalStrategy = pack.retrieval_strategy ?? 'default'
  const hasExecutionSlice = pack.execution_slice !== undefined

  const checks = {
    generation_intent: prompt.allowed_generation_intents?.includes(generationIntent) ?? true,
    target_domain_hint: prompt.allowed_target_domain_hints?.includes(targetDomainHint) ?? true,
    retrieval_strategy: prompt.required_retrieval_strategy ? retrievalStrategy === prompt.required_retrieval_strategy : true,
    execution_slice: typeof prompt.require_execution_slice === 'boolean'
      ? hasExecutionSlice === prompt.require_execution_slice
      : true,
  }

  const failures = Object.entries(checks)
    .filter(([, passed]) => passed !== true)
    .map(([name]) => name)

  return {
    checks,
    passed: failures.length === 0,
    failures,
    actual_domain: inferActualDomain(targetDomainHint),
  }
}

function main() {
  const { graph, prompts, output, budget } = parseArgs(process.argv.slice(2))
  const promptList = JSON.parse(readFileSync(prompts, 'utf8'))
  const workspaceRoot = resolve(dirname(graph), '..')
  const cliPath = resolve(repoRoot, 'dist/src/cli/bin.js')

  const records = promptList.map((prompt) => {
    const payload = runPack(cliPath, graph, budget, prompt.question)
    const pack = payload.pack ?? {}
    const gate = payload.retrieval_gate ?? pack.retrieval_gate ?? {}
    const signals = gate.signals ?? {}
    const evaluation = evaluatePrompt(prompt, payload)

    return {
      id: prompt.id,
      class: prompt.class,
      question: prompt.question,
      expected_domain: prompt.expected_domain,
      retrieval_gate: {
        intent: gate.intent ?? null,
        generation_intent: signals.generation_intent ?? 'unknown',
        target_domain_hint: signals.target_domain_hint ?? 'unknown',
      },
      retrieval_strategy: pack.retrieval_strategy ?? 'default',
      pack_token_count: pack.token_count ?? null,
      matched_nodes: Array.isArray(pack.matched_nodes)
        ? pack.matched_nodes.map((node) => ({
            label: node.label,
            source_file: sanitizeSourceFile(node.source_file, workspaceRoot),
          }))
        : [],
      relationship_count: Array.isArray(pack.relationships) ? pack.relationships.length : 0,
      has_execution_slice: pack.execution_slice !== undefined,
      execution_slice_status: pack.execution_slice?.status ?? null,
      execution_slice_phase_coverage: pack.execution_slice?.phase_coverage ?? null,
      execution_slice_steps: Array.isArray(pack.execution_slice?.steps)
        ? pack.execution_slice.steps.map((step) => step.label)
        : [],
      routing_judgment: evaluation,
    }
  })

  const summary = {
    total_prompts: records.length,
    passed_prompts: records.filter((record) => record.routing_judgment.passed).length,
    failed_prompts: records.filter((record) => !record.routing_judgment.passed).map((record) => record.id),
  }

  writeFileSync(output, `${JSON.stringify({
    generated_at: new Date().toISOString(),
    graph_path: '<workspace-root>/out/graph.json',
    workspace_root: '<workspace-root>',
    budget,
    summary,
    prompts: records,
  }, null, 2)}\n`)
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  if (!message.includes(usage)) {
    console.error(usage)
  }
  process.exit(1)
}
