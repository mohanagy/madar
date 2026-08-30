/**
 * #660-A control G14 — normal product commands never read grader truth.
 *
 * The module-graph guard proves normal product CONSTRUCTION modules cannot
 * reach the grader. It cannot prove anything about the CLI process as a whole,
 * because one binary legitimately hosts `madar compare`, `madar benchmark` and
 * `madar eval` alongside the ordinary commands. That is a real limitation, so
 * this control closes the remaining question behaviourally instead of
 * structurally: with grader truth replaced by a detectable poison, do the normal
 * paths still produce exactly the truthful output?
 *
 * Method:
 *
 *   1. snapshot the real grader data file (bytes and mode);
 *   2. run `madar prompt` and the MCP `context_prompt` tool against truth;
 *   3. replace the file with a schema-valid profile carrying a sentinel;
 *   4. PRECONDITION — load it through the real grader loader and require the
 *      sentinel to come back, proving the poison is active rather than inert;
 *   5. re-run both normal paths;
 *   6. require byte-identical output and no sentinel anywhere in it;
 *   7. restore the file and prove by digest that it went back.
 *
 * Step 4 is what makes the control mean anything. Without it, "the sentinel did
 * not appear" would be satisfied by a poison the loader never saw.
 *
 * This is a focused control for the mixed CLI router. It is not general dynamic
 * taint analysis, and it is not described as such.
 *
 * Runs against `dist/`, so it must run after `npm run build`.
 */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The exact, actionable reason a normal-path grader read reports. */
export const GRADER_TRUTH_READ_DURING_NORMAL_PRODUCT_COMMAND = 'GRADER_TRUTH_READ_DURING_NORMAL_PRODUCT_COMMAND'

const SENTINEL = '__MADAR_660A_POISONED_GRADER_TRUTH__'
const GRADER_DATA = 'docs/benchmarks/suite/runtime-proof.json'
const digest = (value) => createHash('sha256').update(value).digest('hex')

/**
 * A schema-valid profile whose every free-text field carries the sentinel, so a
 * read that reaches any product output is detectable wherever it surfaces.
 */
function poisonedProfiles() {
  return {
    [`${SENTINEL}-row`]: {
      prompt: `${SENTINEL} prompt`,
      strict_runtime_proof: true,
      expected_spi: false,
      obligations: [
        {
          id: `${SENTINEL}_obligation`,
          label: `${SENTINEL} label`,
          kind: 'entrypoint',
          evidence_terms: [`${SENTINEL}_term`, `${SENTINEL}/path.ts`],
        },
      ],
    },
  }
}

function buildProbeWorkspace(root) {
  const workspace = resolve(root, 'out', 'test-runtime', 'grader-boundary-runtime-proof')
  const files = {
    'src/routes.ts': [
      'export function registerRoutes(app) {',
      '  app.post("/login", authenticateUser)',
      '}',
    ].join('\n'),
    'src/auth.ts': [
      'export function authenticateUser(credentials) {',
      '  return new SessionManager().createSession(credentials.userId)',
      '}',
    ].join('\n'),
    'src/session.ts': [
      'export class SessionManager {',
      '  createSession(userId) {',
      '    return new SessionStore().write(userId)',
      '  }',
      '}',
    ].join('\n'),
    'src/session-store.ts': [
      'export class SessionStore {',
      '  write(userId) {',
      '    return `session:${userId}`',
      '  }',
      '}',
    ].join('\n'),
  }
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(workspace, relativePath)
    mkdirSync(resolve(absolute, '..'), { recursive: true })
    writeFileSync(absolute, `${content}\n`, 'utf8')
  }
  return workspace
}

function writeProbeGraph(workspace, KnowledgeGraph, toJson) {
  const graph = new KnowledgeGraph({ directed: true })
  const node = (id, label, sourceFile, kind, community) => graph.addNode(id, {
    label, source_file: sourceFile, source_location: 'L1', line_number: 1, node_kind: kind, file_type: 'code', community,
  })
  node('login_route', 'POST /login', 'src/routes.ts', 'route', 0)
  node('auth_user', 'authenticateUser', 'src/auth.ts', 'function', 0)
  node('session_manager', 'SessionManager', 'src/session.ts', 'class', 0)
  node('session_store', 'SessionStore', 'src/session-store.ts', 'class', 1)
  graph.addEdge('login_route', 'auth_user', { relation: 'handles_route', confidence: 'EXTRACTED', source_file: 'src/routes.ts' })
  graph.addEdge('auth_user', 'session_manager', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/auth.ts' })
  graph.addEdge('session_manager', 'session_store', { relation: 'uses', confidence: 'EXTRACTED', source_file: 'src/session.ts' })

  const outDir = join(workspace, 'out')
  mkdirSync(outDir, { recursive: true })
  const graphPath = join(outDir, 'graph.json')
  toJson(graph, { 0: ['login_route', 'auth_user', 'session_manager'], 1: ['session_store'] }, graphPath)
  return graphPath
}

const QUESTION = 'how does login create a session and persist it'

async function importDist(root, relativePath) {
  const absolute = resolve(root, 'dist', 'src', relativePath)
  if (!existsSync(absolute)) {
    throw new Error(`dist artifact missing: ${absolute}. Run \`npm run build\` before this control.`)
  }
  return import(pathToFileURL(absolute).href)
}

/** The two normal product paths, run for real. */
async function runNormalPaths(root, graphPath) {
  const { runContextPromptCommand } = await importDist(root, 'infrastructure/context-prompt-command.js')
  const { handleStdioRequest } = await importDist(root, 'runtime/stdio-server.js')

  const cliOutput = await runContextPromptCommand({
    prompt: QUESTION,
    provider: 'claude',
    graphPath,
    graphPathIntent: 'explicit',
  })

  const previousProfile = process.env['MADAR_TOOL_PROFILE']
  // context_prompt is only exposed by the full tool profile.
  process.env['MADAR_TOOL_PROFILE'] = 'full'
  let mcpOutput
  try {
    const response = await Promise.resolve(handleStdioRequest(graphPath, {
      id: 1,
      method: 'tools/call',
      params: { name: 'context_prompt', arguments: { prompt: QUESTION, provider: 'claude' } },
    }))
    mcpOutput = JSON.stringify(response)
  } finally {
    if (previousProfile === undefined) delete process.env['MADAR_TOOL_PROFILE']
    else process.env['MADAR_TOOL_PROFILE'] = previousProfile
  }

  return { cliOutput, mcpOutput }
}

export async function runGraderTruthNoReadProof({ root = process.cwd(), log = console.log } = {}) {
  const results = []
  const dataPath = resolve(root, GRADER_DATA)
  const originalBytes = readFileSync(dataPath)
  const originalMode = statSync(dataPath).mode
  const workspace = buildProbeWorkspace(root)

  let truthful
  let poisoned
  let preconditionDetail = ''
  let preconditionHeld = false

  try {
    const { KnowledgeGraph } = await importDist(root, 'contracts/graph.js')
    const { toJson } = await importDist(root, 'pipeline/export.js')
    const graphPath = writeProbeGraph(workspace, KnowledgeGraph, toJson)

    truthful = await runNormalPaths(root, graphPath)

    // ---- poison ----
    writeFileSync(dataPath, `${JSON.stringify(poisonedProfiles(), null, 2)}\n`, 'utf8')
    chmodSync(dataPath, originalMode)

    // PRECONDITION: the real grader loader must observe the poison. Without
    // this, "no sentinel in the output" would also be true of a poison nothing
    // could ever have read.
    const { loadBenchmarkRuntimeProofProfiles } = await importDist(root, 'infrastructure/benchmark/runtime-proof.js')
    const observed = loadBenchmarkRuntimeProofProfiles(dataPath)
    const observedText = observed ? JSON.stringify([...observed.entries()]) : ''
    preconditionHeld = observedText.includes(SENTINEL)
    preconditionDetail = preconditionHeld
      ? `grader loader observed the poison (${observed.size} profile(s))`
      : `grader loader did NOT observe the poison; the control would prove nothing`

    poisoned = await runNormalPaths(root, graphPath)
  } catch (error) {
    preconditionDetail = `${preconditionDetail} | threw: ${error?.message ?? String(error)}`
  } finally {
    writeFileSync(dataPath, originalBytes)
    chmodSync(dataPath, originalMode)
    rmSync(workspace, { recursive: true, force: true })
  }

  const restoredBytes = readFileSync(dataPath)
  const restored = digest(restoredBytes) === digest(originalBytes) && statSync(dataPath).mode === originalMode

  results.push({
    id: 'G14a',
    title: 'precondition: the real grader loader observes the poisoned truth',
    passed: preconditionHeld,
    detail: preconditionDetail,
  })

  // Second precondition. "The outputs matched" is also true of two identical
  // failures, so require both arms to be substantive prompt packs before their
  // equality is allowed to mean anything.
  const substantive = (run) => run !== undefined
    && run.cliOutput.length > 2000 && run.cliOutput.includes('"prompt"') && run.cliOutput.includes('"graph_path"')
    && run.mcpOutput.length > 2000 && run.mcpOutput.includes('"result"') && !run.mcpOutput.includes('"error"')
  const bothSubstantive = substantive(truthful) && substantive(poisoned)
  results.push({
    id: 'G14e',
    title: 'precondition: both arms produced substantive prompt packs, not matching failures',
    passed: bothSubstantive,
    detail: bothSubstantive
      ? `truthful cli=${truthful.cliOutput.length}B mcp=${truthful.mcpOutput.length}B; poisoned cli=${poisoned.cliOutput.length}B mcp=${poisoned.mcpOutput.length}B`
      : 'at least one arm did not produce a usable prompt pack, so an equality result would be vacuous',
  })

  const sentinelFree = poisoned !== undefined
    && !poisoned.cliOutput.includes(SENTINEL)
    && !poisoned.mcpOutput.includes(SENTINEL)
  results.push({
    id: 'G14b',
    title: `normal product commands carry no grader value (${GRADER_TRUTH_READ_DURING_NORMAL_PRODUCT_COMMAND} on failure)`,
    passed: sentinelFree,
    detail: sentinelFree
      ? 'no sentinel in the madar prompt output or the MCP context_prompt response'
      : `${GRADER_TRUTH_READ_DURING_NORMAL_PRODUCT_COMMAND}: a grader-derived value reached normal product output`,
  })

  const identical = truthful !== undefined && poisoned !== undefined
    && truthful.cliOutput === poisoned.cliOutput
    && truthful.mcpOutput === poisoned.mcpOutput
  results.push({
    id: 'G14c',
    title: 'normal product output is byte-identical with grader truth poisoned',
    passed: identical,
    detail: identical
      ? 'madar prompt and MCP context_prompt output unchanged by the poison'
      : `${GRADER_TRUTH_READ_DURING_NORMAL_PRODUCT_COMMAND}: output differed once grader truth changed`,
  })

  results.push({
    id: 'G14d',
    title: 'grader truth restored byte-for-byte and mode-for-mode',
    passed: restored,
    detail: restored ? `digest ${digest(restoredBytes).slice(0, 16)} matches the pre-run file` : 'RESTORATION FAILED',
  })

  for (const result of results) {
    log(`  ${result.passed ? 'PASS' : 'FAIL'}  ${result.id}  ${result.title}`)
    log(`         ${result.detail}`)
  }

  return { ok: results.every((result) => result.passed), results }
}
