/**
 * #660-A — structural grader/runtime separation.
 *
 * Normal Madar product paths must not import, read, receive, or TRANSITIVELY
 * reach qualification grader truth. Before #660-A that separation was a
 * call-graph property: `src/runtime/stdio/tools.ts` and
 * `src/infrastructure/context-prompt-command.ts` value-imported a prompt-pack
 * builder that happened to live in the grader module, so the runtime-proof
 * loader sat in the module graph of every normal MCP and CLI prompt path even
 * though no normal call reached it.
 *
 * This guard replaces that with a structural one. It works OUTWARD from the
 * grader module using the TypeScript compiler's own module resolution, so it
 * does not depend on enumerating every normal CLI and MCP root, and it cannot
 * be defeated by a rename, a re-export, or an intermediate helper.
 *
 * A regex import scan is NOT the authority here. `textualDataReferences()` is a
 * secondary control for the one thing the compiler graph cannot represent: a
 * direct filesystem read of the grader JSON.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import ts from 'typescript'

/** The exact, actionable reason a violation reports. Asserted by the controls. */
export const GRADER_TRUTH_REACHABLE = 'GRADER_TRUTH_REACHABLE_FROM_NORMAL_PRODUCT'
/** Reported when the allowlist itself is malformed or overbroad. */
export const GRADER_BOUNDARY_CONFIG_INVALID = 'GRADER_BOUNDARY_CONFIG_INVALID'

const toPosix = (value) => value.replaceAll('\\', '/')

/** Repo-relative POSIX path, so reports are byte-identical on every platform. */
function relPath(root, absolute) {
  return toPosix(relative(root, absolute))
}

function listTypeScriptSources(root, dir, out) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      listTypeScriptSources(root, full, out)
    } else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) {
      out.push(relPath(root, full))
    }
  }
  return out
}

function loadProgram(root) {
  const configPath = resolve(root, 'tsconfig.build.json')
  const read = ts.readConfigFile(configPath, ts.sys.readFile)
  if (read.error) {
    throw new Error(`unreadable tsconfig.build.json: ${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`)
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath))
  if (parsed.errors.length > 0) {
    throw new Error(`invalid tsconfig.build.json: ${parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('; ')}`)
  }
  return {
    program: ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options }),
    options: parsed.options,
  }
}

/**
 * True when the declaration survives to runtime.
 *
 * `verbatimModuleSyntax` is on, so `import type` / `export type` and named
 * clauses whose every specifier is `type`-marked are fully erased and create no
 * runtime dependency. Everything else does, including a bare side-effect
 * import, which is exactly how a grader module gets pulled in accidentally.
 */
function isRuntimeImport(node) {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause
    if (!clause) return true // side-effect import
    if (clause.isTypeOnly) return false
    if (clause.name) return true // default import
    const bindings = clause.namedBindings
    if (!bindings) return true
    if (ts.isNamespaceImport(bindings)) return true
    return bindings.elements.length === 0 || !bindings.elements.every((element) => element.isTypeOnly)
  }
  if (ts.isExportDeclaration(node)) {
    if (node.isTypeOnly) return false
    const clause = node.exportClause
    if (!clause) return true // export * from
    if (ts.isNamespaceExport(clause)) return true
    return clause.elements.length === 0 || !clause.elements.every((element) => element.isTypeOnly)
  }
  return true
}

/**
 * The statically-known specifier of a dynamic `import()` / `require()`, or null
 * when it is computed.
 *
 * A quoted string is not the only literal form TypeScript accepts here: a
 * backtick specifier with no substitutions parses as a
 * NoSubstitutionTemplateLiteral, and `ts.isStringLiteral` rejects it. Missing
 * that shape would leave `import(\`./benchmark/runtime-proof.js\`)` as a real
 * runtime edge the graph never sees. Parentheses and `as const` are unwrapped
 * for the same reason.
 */
function literalSpecifier(node) {
  let current = node
  while (current) {
    if (ts.isParenthesizedExpression(current)) { current = current.expression; continue }
    if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) { current = current.expression; continue }
    break
  }
  if (!current) return null
  if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) return current.text
  return null
}

/**
 * Every runtime edge in `src/**`, resolved by the compiler rather than by text.
 * Dynamic `import()` and `require()` with a literal specifier count: a lazily
 * loaded grader module is still reachable, and treating it as absent would
 * leave an obvious bypass.
 */
function buildRuntimeGraph(root, program, options) {
  const host = ts.createCompilerHost(options)
  const cache = ts.createModuleResolutionCache(root, (value) => value, options)
  const forward = new Map()
  const reverse = new Map()
  const computed = []

  const resolveSpecifier = (specifier, containingFile) => {
    const resolved = ts.resolveModuleName(specifier, containingFile, options, host, cache)
    const file = resolved.resolvedModule?.resolvedFileName
    if (!file || file.includes('node_modules')) return null
    const relative_ = relPath(root, file)
    return relative_.startsWith('src/') ? relative_ : null
  }

  const addEdge = (from, to, kind, specifier, line) => {
    if (!forward.has(from)) forward.set(from, [])
    forward.get(from).push({ to, kind, specifier, line })
    if (!reverse.has(to)) reverse.set(to, [])
    reverse.get(to).push({ from, kind, specifier, line })
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue
    const from = relPath(root, sourceFile.fileName)
    if (!from.startsWith('src/')) continue

    const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1

    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        if (ts.isStringLiteral(node.moduleSpecifier) && isRuntimeImport(node)) {
          const to = resolveSpecifier(node.moduleSpecifier.text, sourceFile.fileName)
          if (to) addEdge(from, to, ts.isImportDeclaration(node) ? 'import' : 'export-from', node.moduleSpecifier.text, lineOf(node))
        }
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        const specifier = literalSpecifier(node.moduleReference.expression)
        if (specifier !== null) {
          const to = resolveSpecifier(specifier, sourceFile.fileName)
          if (to) addEdge(from, to, 'import-equals', specifier, lineOf(node))
        }
      } else if (ts.isCallExpression(node)) {
        const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
        const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
        const argument = node.arguments[0]
        if ((isDynamicImport || isRequire) && argument) {
          const specifier = literalSpecifier(argument)
          const kind = isDynamicImport ? 'dynamic-import' : 'require'
          if (specifier !== null) {
            const to = resolveSpecifier(specifier, sourceFile.fileName)
            if (to) addEdge(from, to, kind, specifier, lineOf(node))
          } else {
            // A computed specifier cannot be resolved, so the edge it creates is
            // invisible to this graph. Rather than pretend otherwise, record it
            // and require an explicit justified entry for every one that lives
            // in product code.
            computed.push({ file: from, line: lineOf(node), kind, text: argument.getText(sourceFile).slice(0, 120) })
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }

  return { forward, reverse, computed }
}

/**
 * Literal references to the grader data file anywhere in `src/**`.
 *
 * The compiler graph cannot see `readFileSync('.../runtime-proof.json')`, so
 * this is the secondary control that covers it. It also derives the seed, which
 * is why the loader module is found from the tree rather than hard-coded.
 */
function textualDataReferences(root, program, dataFileBasenames) {
  const references = []
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue
    const file = relPath(root, sourceFile.fileName)
    if (!file.startsWith('src/')) continue
    const visit = (node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const text = toPosix(node.text)
        const matched = dataFileBasenames.find((basename) => text.includes(basename))
        if (matched) {
          references.push({
            file,
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
            literal: node.text,
            dataFile: matched,
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return references
}

function validateConfig(root, config) {
  const problems = []
  const push = (message) => problems.push(`${GRADER_BOUNDARY_CONFIG_INVALID}: ${message}`)

  if (!Array.isArray(config.grader_data_files) || config.grader_data_files.length === 0) {
    push('grader_data_files must be a non-empty array')
  } else {
    for (const dataFile of config.grader_data_files) {
      if (typeof dataFile !== 'string' || dataFile.length === 0) push('grader_data_files entries must be non-empty strings')
      else if (!existsSync(resolve(root, dataFile))) push(`grader_data_files entry does not exist: ${dataFile}`)
    }
  }

  if (!Array.isArray(config.allowed_grader_ancestors) || config.allowed_grader_ancestors.length === 0) {
    push('allowed_grader_ancestors must be a non-empty array')
  } else {
    const seenPaths = new Set()
    for (const entry of config.allowed_grader_ancestors) {
      if (entry === null || typeof entry !== 'object') { push('every allowed_grader_ancestors entry must be an object'); continue }
      const { path, role, justification } = entry
      if (typeof path !== 'string' || path.length === 0) { push('an allowed ancestor is missing "path"'); continue }
      // Exact paths only. A glob would be the overbroad exception this guard exists to prevent.
      if (/[*?[\]]/.test(path) || path.endsWith('/')) push(`allowed ancestor "${path}" must be an exact file path, not a pattern or directory`)
      if (!path.startsWith('src/') || !path.endsWith('.ts')) push(`allowed ancestor "${path}" must be a src/**.ts file`)
      if (!existsSync(resolve(root, path))) push(`allowed ancestor "${path}" does not exist`)
      if (seenPaths.has(path)) push(`allowed ancestor "${path}" is listed twice`)
      seenPaths.add(path)
      if (typeof role !== 'string' || role.length === 0) push(`allowed ancestor "${path}" is missing "role"`)
      if (typeof justification !== 'string' || justification.trim().length < 20) {
        push(`allowed ancestor "${path}" needs a substantive "justification"`)
      }
    }
  }

  if (!Array.isArray(config.normal_product_roots) || config.normal_product_roots.length === 0) {
    push('normal_product_roots must be a non-empty array')
  }

  // The denylist is the anti-drift rule: a future violation inside normal
  // product construction must not be resolvable by appending to the allowlist.
  const denied = (config.normal_product_roots ?? []).filter((prefix) => typeof prefix === 'string')
  for (const entry of config.allowed_grader_ancestors ?? []) {
    const path = entry?.path
    if (typeof path !== 'string') continue
    const conflict = denied.find((prefix) => path === prefix || path.startsWith(prefix))
    if (conflict) push(`allowed ancestor "${path}" is inside the normal-product root "${conflict}" and can never be allowlisted`)
  }

  return problems
}

/**
 * Building a TypeScript program per call is the expensive part, and the config
 * validation controls call this many times against an unchanged tree. The cache
 * is keyed by root and MUST be bypassed by anything that mutates sources; the
 * self-test passes `cache: false` and additionally asserts that each injected
 * edge is present in the analyzed graph, so a stale graph cannot pass a control.
 */
const graphCache = new Map()

export function invalidateGraderBoundaryCache() {
  graphCache.clear()
}

function runtimeGraphFor(root, useCache) {
  if (useCache && graphCache.has(root)) return graphCache.get(root)
  const { program, options } = loadProgram(root)
  const built = { program, graph: buildRuntimeGraph(root, program, options) }
  if (useCache) graphCache.set(root, built)
  return built
}

/**
 * @param {{ root?: string, config?: object, cache?: boolean }} [input]
 */
export function analyzeGraderBoundary(input = {}) {
  const root = input.root ?? process.cwd()
  const config = input.config ?? JSON.parse(readFileSync(resolve(root, 'docs/architecture/grader-boundary.json'), 'utf8'))

  const configProblems = validateConfig(root, config)
  if (configProblems.length > 0) {
    return { ok: false, reason: GRADER_BOUNDARY_CONFIG_INVALID, configProblems, violations: [], ancestors: [], seeds: [], dataReferences: [] }
  }

  const { program, graph } = runtimeGraphFor(root, input.cache !== false)
  const { reverse, computed } = graph

  const basenames = config.grader_data_files.map((dataFile) => toPosix(dataFile).split('/').pop())
  const dataReferences = textualDataReferences(root, program, basenames)

  // The seed is DERIVED: whichever production module names the grader data file
  // is the loader, whatever it is called today.
  const seeds = [...new Set(dataReferences.map((reference) => reference.file))].sort()
  if (seeds.length === 0) {
    return {
      ok: false,
      reason: GRADER_BOUNDARY_CONFIG_INVALID,
      configProblems: [`${GRADER_BOUNDARY_CONFIG_INVALID}: no src/** module references ${config.grader_data_files.join(', ')}; the seed could not be derived`],
      violations: [], ancestors: [], seeds: [], dataReferences,
    }
  }

  // Reverse breadth-first search keeps the SHORTEST chain to each ancestor, so
  // a failure report names the specific edge to cut.
  const chains = new Map()
  const queue = seeds.map((seed) => [seed, [seed]])
  const seen = new Set(seeds)
  while (queue.length > 0) {
    const [node, chain] = queue.shift()
    for (const { from, kind, specifier, line } of (reverse.get(node) ?? []).slice().sort((a, b) => a.from.localeCompare(b.from))) {
      if (seen.has(from)) continue
      seen.add(from)
      const next = [from, ...chain]
      chains.set(from, { chain: next, kind, specifier, line })
      queue.push([from, next])
    }
  }

  const allowed = new Map((config.allowed_grader_ancestors ?? []).map((entry) => [entry.path, entry]))
  const normalRoots = config.normal_product_roots ?? []
  const inNormalProduct = (file) => normalRoots.find((prefix) => file === prefix || file.startsWith(prefix))

  const violations = []
  for (const file of [...chains.keys()].sort()) {
    const { chain, kind, specifier, line } = chains.get(file)
    const normalRoot = inNormalProduct(file)
    if (normalRoot) {
      violations.push({
        reason: GRADER_TRUTH_REACHABLE,
        file,
        line,
        rule: 'normal_product_root',
        detail: `"${file}" is normal product code (root "${normalRoot}") and reaches grader truth through a ${kind} of '${specifier}'`,
        chain,
      })
      continue
    }
    if (!allowed.has(file)) {
      violations.push({
        reason: GRADER_TRUTH_REACHABLE,
        file,
        line,
        rule: 'not_allowlisted',
        detail: `"${file}" reaches grader truth through a ${kind} of '${specifier}' and is not an approved grader/benchmark ancestor`,
        chain,
      })
    }
  }

  // Secondary control: a direct read of the grader JSON from anywhere that is
  // not an approved ancestor, which the module graph alone cannot express.
  for (const reference of dataReferences) {
    if (allowed.has(reference.file)) continue
    const normalRoot = inNormalProduct(reference.file)
    violations.push({
      reason: GRADER_TRUTH_REACHABLE,
      file: reference.file,
      line: reference.line,
      rule: normalRoot ? 'direct_data_read_in_normal_product' : 'direct_data_read_not_allowlisted',
      detail: `"${reference.file}" names the grader data file "${reference.dataFile}" directly${normalRoot ? ` from normal product root "${normalRoot}"` : ''}`,
      chain: [reference.file],
    })
  }

  // A computed dynamic specifier cannot be resolved, so the edge it creates is
  // invisible to this graph. Every one that survives in production must be an
  // explicit, justified entry, exactly like an allowlisted ancestor — otherwise
  // `import(someVariable)` would be a silent way around the whole boundary.
  const allowedComputed = new Map(
    (config.allowed_computed_dynamic_imports ?? []).map((entry) => [entry?.path, entry]),
  )
  for (const entry of computed) {
    const approved = allowedComputed.get(entry.file)
    if (approved && typeof approved.justification === 'string' && approved.justification.trim().length >= 20) continue
    violations.push({
      reason: GRADER_TRUTH_REACHABLE,
      file: entry.file,
      line: entry.line,
      rule: 'computed_specifier_unverifiable',
      detail: `"${entry.file}" uses a computed ${entry.kind} specifier (${entry.text}), so this guard cannot prove where it resolves`,
      chain: [entry.file],
    })
  }

  const unusedAllowances = [...allowed.keys()].filter((path) => !chains.has(path) && !seeds.includes(path)).sort()

  return {
    ok: violations.length === 0,
    reason: violations.length === 0 ? null : GRADER_TRUTH_REACHABLE,
    configProblems: [],
    seeds,
    ancestors: [...chains.keys()].sort(),
    dataReferences,
    computedSpecifiers: computed,
    unusedAllowances,
    violations,
  }
}

export function formatGraderBoundaryReport(result) {
  if (result.configProblems?.length > 0) {
    return ['Grader boundary configuration is invalid:', ...result.configProblems.map((problem) => `  - ${problem}`)].join('\n')
  }
  if (result.ok) {
    const lines = [
      `Grader boundary OK. Seed(s): ${result.seeds.join(', ')}`,
      `Approved grader/benchmark ancestors reached: ${result.ancestors.length}`,
      ...result.ancestors.map((file) => `  - ${file}`),
    ]
    if (result.unusedAllowances?.length > 0) {
      lines.push(`Allowlist entries no longer reaching grader truth (safe to remove): ${result.unusedAllowances.join(', ')}`)
    }
    return lines.join('\n')
  }
  const lines = [`${GRADER_TRUTH_REACHABLE}: ${result.violations.length} violation(s).`]
  for (const violation of result.violations) {
    lines.push('')
    lines.push(`  ${violation.file}:${violation.line}  [${violation.rule}]`)
    lines.push(`    ${violation.detail}`)
    lines.push(`    reach: ${violation.chain.join(' -> ')}`)
  }
  lines.push('')
  lines.push('Remedy: move the shared code into a module that does not depend on the grader,')
  lines.push('or, if this really is grader/benchmark code, add an exact justified entry to')
  lines.push('docs/architecture/grader-boundary.json. Normal product roots can never be allowlisted.')
  return lines.join('\n')
}

/**
 * #660-A section 9 — grader sequencing.
 *
 * The module graph proves normal product code cannot REACH grader truth. This
 * proves the remaining ordering property inside the grader itself: expected
 * evidence is consulted only after the artifact being graded is fixed on disk,
 * and the loaded profile flows only into grading, never back into an input arm.
 *
 * Both facts are read off the syntax tree rather than off a comment, so they
 * stay true when the comment stops being. Files are re-parsed with parent
 * pointers because scope resolution needs them.
 */
export function analyzeGraderSequencing(input = {}) {
  const root = input.root ?? process.cwd()
  const config = input.config ?? JSON.parse(readFileSync(resolve(root, 'docs/architecture/grader-boundary.json'), 'utf8'))
  const sequencing = config.sequencing ?? {}
  const loaderName = sequencing.loader_function
  const artifactFixName = sequencing.artifact_fix_function
  const approvedConsumers = new Set(sequencing.approved_profile_consumers ?? [])

  if (!loaderName || !artifactFixName || approvedConsumers.size === 0) {
    return {
      ok: false,
      problems: [`${GRADER_BOUNDARY_CONFIG_INVALID}: sequencing needs loader_function, artifact_fix_function and a non-empty approved_profile_consumers`],
      sites: [],
    }
  }

  const problems = []
  const sites = []

  const calleeName = (node) => {
    if (!node || !ts.isCallExpression(node)) return null
    const callee = node.expression
    if (ts.isIdentifier(callee)) return callee.text
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) return callee.name.text
    return null
  }

  const enclosingFunction = (node) => {
    for (let current = node.parent; current; current = current.parent) {
      if (
        ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current)
        || ts.isArrowFunction(current) || ts.isMethodDeclaration(current)
      ) return current
    }
    return null
  }

  for (const relative_ of productionSourceFiles(root)) {
    const absolute = resolve(root, relative_)
    const text = readFileSync(absolute, 'utf8')
    if (!text.includes(loaderName)) continue
    const sourceFile = ts.createSourceFile(absolute, text, ts.ScriptTarget.ES2022, /* setParentNodes */ true, ts.ScriptKind.TS)
    const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1

    const loaderCalls = []
    const artifactFixCalls = []
    const collect = (node) => {
      const name = calleeName(node)
      if (name === loaderName) loaderCalls.push(node)
      else if (name === artifactFixName) artifactFixCalls.push(node)
      ts.forEachChild(node, collect)
    }
    collect(sourceFile)
    if (loaderCalls.length === 0) continue

    for (const loaderCall of loaderCalls) {
      const loaderLine = lineOf(loaderCall)
      const scope = enclosingFunction(loaderCall)
      const site = { file: relative_, line: loaderLine, wrappers: [], artifactFixesBefore: [], profileConsumers: [] }

      if (!scope) {
        problems.push(`${relative_}:${loaderLine} consults ${loaderName} at module scope, where ordering against the graded artifact cannot be established`)
        sites.push(site)
        continue
      }

      // The loader result may be wrapped (it is: matchBenchmarkRuntimeProofProfile
      // selects the row). Every wrapper on the way to the binding must itself be
      // an approved grader consumer.
      let node = loaderCall
      let binding = null
      for (let current = loaderCall.parent; current; current = current.parent) {
        if (ts.isCallExpression(current)) {
          const wrapper = calleeName(current)
          site.wrappers.push(wrapper)
          if (!approvedConsumers.has(wrapper)) {
            problems.push(`${relative_}:${lineOf(current)} wraps grader truth in "${wrapper}", which is not an approved grader consumer`)
          }
          node = current
          continue
        }
        if (ts.isVariableDeclaration(current)) { binding = current; break }
        if (ts.isExpressionStatement(current) || ts.isBlock(current) || current === scope) break
      }
      void node

      // (a) every artifact-fixing call in this scope must run BEFORE the load.
      const inScope = artifactFixCalls.filter((fix) => (
        fix.getStart(sourceFile) >= scope.getStart(sourceFile) && fix.getEnd() <= scope.getEnd()
      ))
      if (inScope.length === 0) {
        problems.push(`${relative_}:${loaderLine} consults ${loaderName} in a scope that never fixes a graded artifact via ${artifactFixName}`)
      }
      for (const fix of inScope) {
        const fixLine = lineOf(fix)
        if (fix.getStart(sourceFile) > loaderCall.getStart(sourceFile)) {
          problems.push(`${relative_}:${fixLine} fixes the graded artifact AFTER ${loaderName} was consulted at line ${loaderLine}`)
        } else {
          site.artifactFixesBefore.push(fixLine)
        }
      }

      // (b) the bound profile may only flow into approved grader consumers.
      const bound = binding && ts.isIdentifier(binding.name) ? binding.name.text : null
      if (!bound) {
        problems.push(`${relative_}:${loaderLine} does not bind grader truth to a named local, so its downstream flow cannot be checked`)
      } else {
        const walk = (current) => {
          if (ts.isIdentifier(current) && current.text === bound && current !== binding.name) {
            let holder = current.parent
            while (holder && !ts.isCallExpression(holder) && holder !== scope) holder = holder.parent
            const consumer = calleeName(holder)
            const line = lineOf(current)
            site.profileConsumers.push({ line, consumer })
            if (!consumer) {
              problems.push(`${relative_}:${line} uses grader truth outside any call, so its destination is unverifiable`)
            } else if (!approvedConsumers.has(consumer)) {
              problems.push(`${relative_}:${line} passes grader truth to "${consumer}", which is not an approved grader consumer`)
            }
          }
          ts.forEachChild(current, walk)
        }
        walk(scope)
        if (site.profileConsumers.length === 0) {
          problems.push(`${relative_}:${loaderLine} loads grader truth but never uses it, which makes the sequencing claim vacuous`)
        }
      }

      sites.push(site)
    }
  }

  if (sites.length === 0) {
    problems.push(`no call to ${loaderName} was found in src/**; the sequencing claim cannot be verified`)
  }

  return { ok: problems.length === 0, problems, sites }
}

export function productionSourceFiles(root = process.cwd()) {
  return listTypeScriptSources(root, resolve(root, 'src'), [])
}
