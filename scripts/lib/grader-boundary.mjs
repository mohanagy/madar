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
 * Three exemption shapes exist, and each is deliberately narrow:
 *
 *   - a DEDICATED grader/benchmark module may be approved as a whole module,
 *     because reaching grader truth is its entire job;
 *   - a MIXED CLI router — one binary hosting both product and grader commands
 *     — is never trusted as a whole file. Only its exact grader-reaching edges
 *     are approved, by kind, specifier, destination and imported bindings;
 *   - a COMPUTED import specifier, which the compiler cannot resolve, is
 *     approved per call site by enclosing declaration and normalized
 *     expression, never per file.
 *
 * The last rule exists because a file-wide exemption is precisely the quiet
 * widening this guard is built to prevent: one legitimate computed import must
 * not license arbitrary later ones in the same file.
 *
 * A regex import scan is NOT the authority here. `textualDataReferences()` is a
 * secondary control for the one thing the compiler graph cannot represent: a
 * direct filesystem read of the grader JSON.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import ts from 'typescript'

/** Reported when grader truth is reachable from code that must not reach it. */
export const GRADER_TRUTH_REACHABLE = 'GRADER_TRUTH_REACHABLE_FROM_NORMAL_PRODUCT'
/** Reported when a computed specifier is not covered by an exact call-site allowance. */
export const COMPUTED_DYNAMIC_IMPORT_NOT_EXACTLY_ALLOWED = 'COMPUTED_DYNAMIC_IMPORT_NOT_EXACTLY_ALLOWED'
/** Reported when a mixed command router carries an unapproved grader-reaching edge. */
export const UNAPPROVED_MIXED_ROUTER_GRADER_EDGE = 'UNAPPROVED_MIXED_ROUTER_GRADER_EDGE'
/** Reported when the boundary configuration is itself malformed or overbroad. */
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

export function productionSourceFiles(root = process.cwd()) {
  return listTypeScriptSources(root, resolve(root, 'src'), [])
}

function loadCompilerOptions(root) {
  const configPath = resolve(root, 'tsconfig.build.json')
  const read = ts.readConfigFile(configPath, ts.sys.readFile)
  if (read.error) {
    throw new Error(`unreadable tsconfig.build.json: ${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`)
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath))
  if (parsed.errors.length > 0) {
    throw new Error(`invalid tsconfig.build.json: ${parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('; ')}`)
  }
  return parsed.options
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

/** The runtime binding names an import declaration actually introduces. */
function runtimeBindings(node) {
  if (!ts.isImportDeclaration(node)) return []
  const clause = node.importClause
  if (!clause || clause.isTypeOnly) return []
  const names = []
  if (clause.name) names.push(clause.name.text)
  const bindings = clause.namedBindings
  if (bindings && ts.isNamespaceImport(bindings)) names.push(`* as ${bindings.name.text}`)
  if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) if (!element.isTypeOnly) names.push(element.name.text)
  }
  return names.sort()
}

/**
 * The statically-known specifier of a dynamic `import()` / `require()`, or null
 * when it is computed.
 *
 * A quoted string is not the only literal form TypeScript accepts here: a
 * backtick specifier with no substitutions parses as a
 * NoSubstitutionTemplateLiteral, and `ts.isStringLiteral` rejects it. Missing
 * that shape would leave a template-literal import of the grader loader as a
 * real runtime edge the graph never sees. Parentheses and `as const` are
 * unwrapped for the same reason.
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

/** Whitespace-collapsed source text, so reformatting alone never moves a fingerprint. */
const normalizeExpression = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

/**
 * Every runtime edge in `src/**`, resolved by the compiler rather than by text,
 * plus the inventory of computed specifiers the compiler cannot resolve.
 *
 * Dynamic `import()` and `require()` count: a lazily loaded grader module is
 * still reachable, and treating it as absent would leave an obvious bypass.
 */
function buildRuntimeGraph(root, options) {
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

  const addEdge = (edge) => {
    if (!forward.has(edge.from)) forward.set(edge.from, [])
    forward.get(edge.from).push(edge)
    if (!reverse.has(edge.to)) reverse.set(edge.to, [])
    reverse.get(edge.to).push(edge)
  }

  for (const relativeFile of productionSourceFiles(root)) {
    const absolute = resolve(root, relativeFile)
    const sourceFile = ts.createSourceFile(absolute, readFileSync(absolute, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
    const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1

    // The enclosing declaration is tracked on the way down, so a computed call
    // site is identified by the function it lives in rather than by a line
    // number that an unrelated edit can move.
    const scope = []
    const visit = (node) => {
      let pushed = false
      if (ts.isFunctionDeclaration(node) && node.name) { scope.push(node.name.text); pushed = true }
      else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) { scope.push(node.name.text); pushed = true }
      else if ((ts.isFunctionExpression(node) || ts.isArrowFunction(node))
        && node.parent && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
        scope.push(node.parent.name.text); pushed = true
      }

      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        if (ts.isStringLiteral(node.moduleSpecifier) && isRuntimeImport(node)) {
          const to = resolveSpecifier(node.moduleSpecifier.text, absolute)
          if (to) {
            addEdge({
              from: relativeFile,
              to,
              kind: ts.isImportDeclaration(node) ? 'import' : 'export-from',
              specifier: node.moduleSpecifier.text,
              bindings: runtimeBindings(node),
              line: lineOf(node),
            })
          }
        }
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        const specifier = literalSpecifier(node.moduleReference.expression)
        if (specifier !== null) {
          const to = resolveSpecifier(specifier, absolute)
          if (to) addEdge({ from: relativeFile, to, kind: 'import-equals', specifier, bindings: [], line: lineOf(node) })
        }
      } else if (ts.isCallExpression(node)) {
        const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
        const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
        const argument = node.arguments[0]
        if ((isDynamicImport || isRequire) && argument) {
          const kind = isDynamicImport ? 'dynamic-import' : 'require'
          const specifier = literalSpecifier(argument)
          if (specifier !== null) {
            const to = resolveSpecifier(specifier, absolute)
            if (to) addEdge({ from: relativeFile, to, kind, specifier, bindings: [], line: lineOf(node) })
          } else {
            computed.push({
              path: relativeFile,
              kind,
              enclosing_declaration: scope.at(-1) ?? '<module>',
              expression: normalizeExpression(argument.getText(sourceFile)),
              line: lineOf(node),
            })
          }
        }
      }

      ts.forEachChild(node, visit)
      if (pushed) scope.pop()
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
function textualDataReferences(root, dataFileBasenames) {
  const references = []
  for (const relativeFile of productionSourceFiles(root)) {
    const absolute = resolve(root, relativeFile)
    const text = readFileSync(absolute, 'utf8')
    if (!dataFileBasenames.some((basename) => text.includes(basename))) continue
    const sourceFile = ts.createSourceFile(absolute, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
    const visit = (node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const literal = toPosix(node.text)
        const matched = dataFileBasenames.find((basename) => literal.includes(basename))
        if (matched) {
          references.push({
            file: relativeFile,
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
  const substantive = (value) => typeof value === 'string' && value.trim().length >= 20

  if (!Array.isArray(config.grader_data_files) || config.grader_data_files.length === 0) {
    push('grader_data_files must be a non-empty array')
  } else {
    for (const dataFile of config.grader_data_files) {
      if (typeof dataFile !== 'string' || dataFile.length === 0) push('grader_data_files entries must be non-empty strings')
      else if (!existsSync(resolve(root, dataFile))) push(`grader_data_files entry does not exist: ${dataFile}`)
    }
  }

  const exactPath = (path, label) => {
    if (typeof path !== 'string' || path.length === 0) { push(`${label} is missing "path"`); return false }
    // Exact paths only. A glob or a directory is the overbroad exception this
    // guard exists to prevent.
    if (/[*?[\]]/.test(path) || path.endsWith('/')) push(`${label} "${path}" must be an exact file path, not a pattern or directory`)
    if (!path.startsWith('src/') || !path.endsWith('.ts')) push(`${label} "${path}" must be a src/**.ts file`)
    if (!existsSync(resolve(root, path))) push(`${label} "${path}" does not exist`)
    return true
  }

  if (!Array.isArray(config.allowed_grader_ancestors) || config.allowed_grader_ancestors.length === 0) {
    push('allowed_grader_ancestors must be a non-empty array')
  } else {
    const seen = new Set()
    for (const entry of config.allowed_grader_ancestors) {
      if (entry === null || typeof entry !== 'object') { push('every allowed_grader_ancestors entry must be an object'); continue }
      if (!exactPath(entry.path, 'allowed ancestor')) continue
      if (seen.has(entry.path)) push(`allowed ancestor "${entry.path}" is listed twice`)
      seen.add(entry.path)
      if (typeof entry.role !== 'string' || entry.role.length === 0) push(`allowed ancestor "${entry.path}" is missing "role"`)
      if (!substantive(entry.justification)) push(`allowed ancestor "${entry.path}" needs a substantive "justification"`)
    }
  }

  const normalRoots = (config.normal_product_roots ?? []).filter((prefix) => typeof prefix === 'string')
  if (normalRoots.length === 0) push('normal_product_roots must be a non-empty array')

  const mixedRouters = (config.mixed_routers ?? []).filter((path) => typeof path === 'string')
  for (const path of mixedRouters) exactPath(path, 'mixed router')

  // The denylist is the anti-drift rule: a violation inside normal product
  // construction must never be resolvable by appending to an allowlist.
  const insideNormal = (path) => normalRoots.find((prefix) => path === prefix || path.startsWith(prefix))
  for (const entry of config.allowed_grader_ancestors ?? []) {
    const path = entry?.path
    if (typeof path !== 'string') continue
    const conflict = insideNormal(path)
    if (conflict) push(`allowed ancestor "${path}" is inside the normal-product root "${conflict}" and can never be allowlisted`)
    if (mixedRouters.includes(path)) {
      push(`"${path}" is a mixed command router and must be approved edge by edge, never as a whole module`)
    }
  }
  for (const path of mixedRouters) {
    const conflict = insideNormal(path)
    if (conflict) push(`mixed router "${path}" is inside the normal-product root "${conflict}" and can never be exempted`)
  }

  const routerEdges = config.allowed_mixed_router_edges ?? []
  if (!Array.isArray(routerEdges)) push('allowed_mixed_router_edges must be an array')
  else {
    const seen = new Set()
    for (const entry of routerEdges) {
      if (entry === null || typeof entry !== 'object') { push('every allowed_mixed_router_edges entry must be an object'); continue }
      const label = `router edge ${entry.from ?? '?'} -> ${entry.specifier ?? '?'}`
      if (!mixedRouters.includes(entry.from)) push(`${label}: "from" must be a declared mixed router`)
      if (typeof entry.kind !== 'string' || entry.kind.length === 0) push(`${label} is missing "kind"`)
      if (typeof entry.specifier !== 'string' || entry.specifier.length === 0) push(`${label} is missing "specifier"`)
      if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith('src/')) push(`${label} is missing a src/** "resolved" destination`)
      if (!Array.isArray(entry.imported_bindings)) push(`${label} is missing "imported_bindings" (use [] for a side-effect import)`)
      if (typeof entry.role !== 'string' || entry.role.length === 0) push(`${label} is missing "role"`)
      if (!substantive(entry.justification)) push(`${label} needs a substantive "justification"`)
      const key = `${entry.from} ${entry.kind} ${entry.specifier}`
      if (seen.has(key)) push(`${label} is listed twice`)
      seen.add(key)
    }
  }

  const computedAllowances = config.allowed_computed_dynamic_imports ?? []
  if (!Array.isArray(computedAllowances)) push('allowed_computed_dynamic_imports must be an array')
  else {
    const seen = new Set()
    for (const entry of computedAllowances) {
      if (entry === null || typeof entry !== 'object') { push('every allowed_computed_dynamic_imports entry must be an object'); continue }
      const label = `computed allowance ${entry.path ?? '?'}::${entry.enclosing_declaration ?? '?'}`
      if (!exactPath(entry.path, 'computed allowance')) continue
      if (typeof entry.kind !== 'string' || entry.kind.length === 0) push(`${label} is missing "kind"`)
      if (typeof entry.enclosing_declaration !== 'string' || entry.enclosing_declaration.length === 0) {
        push(`${label} is missing "enclosing_declaration"; a file-wide computed allowance is never accepted`)
      }
      if (typeof entry.expression !== 'string' || entry.expression.trim().length === 0) {
        push(`${label} is missing the normalized "expression" that identifies the call site`)
      }
      if (typeof entry.role !== 'string' || entry.role.length === 0) push(`${label} is missing "role"`)
      if (!substantive(entry.justification)) push(`${label} needs a substantive "justification"`)
      const key = `${entry.path} ${entry.kind} ${entry.enclosing_declaration} ${normalizeExpression(entry.expression)}`
      if (seen.has(key)) push(`${label} is listed twice`)
      seen.add(key)
    }
  }

  return problems
}

/**
 * Building the graph is the expensive part, and the config-validation controls
 * call this many times against an unchanged tree. The cache is keyed by root and
 * MUST be bypassed by anything that mutates sources; the self-test passes
 * `cache: false` and additionally asserts that each injected premise is present
 * in the analysis, so a stale graph cannot pass a control.
 */
const graphCache = new Map()

export function invalidateGraderBoundaryCache() {
  graphCache.clear()
}

function runtimeGraphFor(root, useCache) {
  if (useCache && graphCache.has(root)) return graphCache.get(root)
  const built = buildRuntimeGraph(root, loadCompilerOptions(root))
  if (useCache) graphCache.set(root, built)
  return built
}

function loadConfig(root, provided) {
  return provided ?? JSON.parse(readFileSync(resolve(root, 'docs/architecture/grader-boundary.json'), 'utf8'))
}

function emptyResult(reason, configProblems, extra = {}) {
  return {
    ok: false,
    reason,
    configProblems,
    violations: [],
    seeds: [],
    ancestors: [],
    graderReachable: [],
    dataReferences: [],
    computedSpecifiers: [],
    routerEdges: [],
    unusedAllowances: [],
    unusedRouterAllowances: [],
    unusedComputedAllowances: [],
    dedicatedAncestors: [],
    mixedRouters: [],
    ...extra,
  }
}

/**
 * @param {{ root?: string, config?: object, cache?: boolean }} [input]
 */
export function analyzeGraderBoundary(input = {}) {
  const root = input.root ?? process.cwd()
  const config = loadConfig(root, input.config)

  const configProblems = validateConfig(root, config)
  if (configProblems.length > 0) {
    return emptyResult(GRADER_BOUNDARY_CONFIG_INVALID, configProblems)
  }

  const { forward, reverse, computed } = runtimeGraphFor(root, input.cache !== false)

  const basenames = config.grader_data_files.map((dataFile) => toPosix(dataFile).split('/').pop())
  const dataReferences = textualDataReferences(root, basenames)

  // The seed is DERIVED: whichever production module names the grader data file
  // is the loader, whatever it is called today.
  const seeds = [...new Set(dataReferences.map((reference) => reference.file))].sort()
  if (seeds.length === 0) {
    return emptyResult(
      GRADER_BOUNDARY_CONFIG_INVALID,
      [`${GRADER_BOUNDARY_CONFIG_INVALID}: no src/** module references ${config.grader_data_files.join(', ')}; the seed could not be derived`],
      { dataReferences, computedSpecifiers: computed },
    )
  }

  // Reverse breadth-first search keeps the SHORTEST chain to each ancestor, so
  // a failure report names the specific edge to cut.
  const chains = new Map()
  const queue = seeds.map((seed) => [seed, [seed]])
  const seen = new Set(seeds)
  while (queue.length > 0) {
    const [node, chain] = queue.shift()
    for (const edge of (reverse.get(node) ?? []).slice().sort((a, b) => a.from.localeCompare(b.from))) {
      if (seen.has(edge.from)) continue
      seen.add(edge.from)
      const next = [edge.from, ...chain]
      chains.set(edge.from, { chain: next, kind: edge.kind, specifier: edge.specifier, line: edge.line })
      queue.push([edge.from, next])
    }
  }
  /** Every module from which grader truth is reachable, seeds included. */
  const graderReachable = new Set([...seeds, ...chains.keys()])

  const allowed = new Map((config.allowed_grader_ancestors ?? []).map((entry) => [entry.path, entry]))
  const mixedRouters = new Set(config.mixed_routers ?? [])
  const normalRoots = config.normal_product_roots ?? []
  const insideNormal = (file) => normalRoots.find((prefix) => file === prefix || file.startsWith(prefix))

  const violations = []

  for (const file of [...chains.keys()].sort()) {
    const { chain, kind, specifier, line } = chains.get(file)
    const normalRoot = insideNormal(file)
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
    // A mixed router is judged edge by edge below, never as a whole file.
    if (mixedRouters.has(file)) continue
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

  // ---- mixed command routers: exact edges only -----------------------------
  //
  // One CLI binary hosts both ordinary product commands and the compare,
  // benchmark and eval grader commands, so the router legitimately reaches
  // grader code. Trusting the whole file would re-open the boundary, so every
  // grader-reaching edge it carries is approved individually.
  const routerAllowances = new Map(
    (config.allowed_mixed_router_edges ?? []).map((entry) => [`${entry.from} ${entry.kind} ${entry.specifier}`, entry]),
  )
  const matchedRouterAllowances = new Set()
  const routerEdges = []

  for (const router of [...mixedRouters].sort()) {
    for (const edge of (forward.get(router) ?? []).slice().sort((a, b) => a.specifier.localeCompare(b.specifier))) {
      if (!graderReachable.has(edge.to)) continue
      const key = `${edge.from} ${edge.kind} ${edge.specifier}`
      const allowance = routerAllowances.get(key)
      const record = {
        from: edge.from,
        kind: edge.kind,
        specifier: edge.specifier,
        resolved: edge.to,
        imported_bindings: edge.bindings,
        line: edge.line,
        approved: false,
      }
      routerEdges.push(record)

      // An edge straight into the grader loader is never approvable, however it
      // is justified: a router may reach a grader command facade, not truth.
      if (seeds.includes(edge.to)) {
        matchedRouterAllowances.add(key)
        violations.push({
          reason: UNAPPROVED_MIXED_ROUTER_GRADER_EDGE,
          file: edge.from,
          line: edge.line,
          rule: 'router_edge_into_grader_loader',
          detail: `"${edge.from}" imports the grader loader "${edge.to}" directly; a mixed router may route to a grader command facade, never to grader truth itself`,
          chain: [edge.from, edge.to],
        })
        continue
      }

      if (!allowance) {
        violations.push({
          reason: UNAPPROVED_MIXED_ROUTER_GRADER_EDGE,
          file: edge.from,
          line: edge.line,
          rule: 'router_edge_not_approved',
          detail: `"${edge.from}" reaches grader truth through an unapproved ${edge.kind} of '${edge.specifier}' (resolves to ${edge.to})`,
          chain: [edge.from, ...(chains.get(edge.to)?.chain ?? [edge.to])],
        })
        continue
      }

      matchedRouterAllowances.add(key)

      if (allowance.resolved !== edge.to) {
        violations.push({
          reason: UNAPPROVED_MIXED_ROUTER_GRADER_EDGE,
          file: edge.from,
          line: edge.line,
          rule: 'router_edge_destination_changed',
          detail: `"${edge.from}" ${edge.kind} of '${edge.specifier}' now resolves to ${edge.to}, but the allowance approves ${allowance.resolved}`,
          chain: [edge.from, edge.to],
        })
        continue
      }

      const approvedBindings = [...(allowance.imported_bindings ?? [])].sort()
      const actualBindings = [...edge.bindings].sort()
      if (JSON.stringify(approvedBindings) !== JSON.stringify(actualBindings)) {
        violations.push({
          reason: UNAPPROVED_MIXED_ROUTER_GRADER_EDGE,
          file: edge.from,
          line: edge.line,
          rule: 'router_edge_bindings_changed',
          detail: `"${edge.from}" ${edge.kind} of '${edge.specifier}' imports [${actualBindings.join(', ')}], but the allowance approves [${approvedBindings.join(', ')}]`,
          chain: [edge.from, edge.to],
        })
        continue
      }

      record.approved = true
    }
  }

  const unusedRouterAllowances = [...routerAllowances.keys()].filter((key) => !matchedRouterAllowances.has(key)).sort()
  for (const unused of unusedRouterAllowances) {
    violations.push({
      reason: UNAPPROVED_MIXED_ROUTER_GRADER_EDGE,
      file: unused.split(' ')[0],
      line: 0,
      rule: 'router_allowance_unused',
      detail: `router allowance "${unused}" matches no grader-reaching edge; a surplus allowance is a standing permission for an edge nobody reviewed`,
      chain: [],
    })
  }

  // ---- computed specifiers: exact call sites only --------------------------
  //
  // A computed specifier cannot be resolved, so the edge it creates is invisible
  // to this graph. One legitimate computed import must not license arbitrary
  // later ones in the same file, so allowances match a single call site.
  const computedAllowances = (config.allowed_computed_dynamic_imports ?? []).map((entry) => ({
    ...entry,
    key: `${entry.path} ${entry.kind} ${entry.enclosing_declaration} ${normalizeExpression(entry.expression)}`,
  }))
  const computedKeys = new Set(computedAllowances.map((entry) => entry.key))
  const matchedComputed = new Set()

  for (const site of computed) {
    const key = `${site.path} ${site.kind} ${site.enclosing_declaration} ${site.expression}`
    if (computedKeys.has(key) && !matchedComputed.has(key)) {
      matchedComputed.add(key)
      continue
    }
    violations.push({
      reason: COMPUTED_DYNAMIC_IMPORT_NOT_EXACTLY_ALLOWED,
      file: site.path,
      line: site.line,
      rule: computedKeys.has(key) ? 'computed_allowance_matched_more_than_once' : 'computed_specifier_not_exactly_allowed',
      detail: computedKeys.has(key)
        ? `two computed ${site.kind} sites in "${site.path}" share the fingerprint ${site.enclosing_declaration} :: ${site.expression}; each site needs its own allowance`
        : `"${site.path}" has a computed ${site.kind} in ${site.enclosing_declaration} with expression ${site.expression}; this guard cannot prove where it resolves and no exact call-site allowance covers it`,
      chain: [site.path],
    })
  }

  const unusedComputedAllowances = computedAllowances
    .filter((entry) => !matchedComputed.has(entry.key))
    .map((entry) => `${entry.path} ${entry.kind} ${entry.enclosing_declaration} :: ${normalizeExpression(entry.expression)}`)
    .sort()
  for (const unused of unusedComputedAllowances) {
    violations.push({
      reason: COMPUTED_DYNAMIC_IMPORT_NOT_EXACTLY_ALLOWED,
      file: unused.split(' ')[0],
      line: 0,
      rule: 'computed_allowance_unused',
      detail: `computed allowance "${unused}" matches no call site; a surplus allowance is a standing permission for an import nobody reviewed`,
      chain: [],
    })
  }

  // Secondary control: a direct read of the grader JSON from anywhere that is
  // not an approved ancestor, which the module graph alone cannot express.
  for (const reference of dataReferences) {
    if (allowed.has(reference.file)) continue
    const normalRoot = insideNormal(reference.file)
    violations.push({
      reason: GRADER_TRUTH_REACHABLE,
      file: reference.file,
      line: reference.line,
      rule: mixedRouters.has(reference.file)
        ? 'direct_data_read_in_mixed_router'
        : normalRoot ? 'direct_data_read_in_normal_product' : 'direct_data_read_not_allowlisted',
      detail: `"${reference.file}" names the grader data file "${reference.dataFile}" directly${normalRoot ? ` from normal product root "${normalRoot}"` : ''}`,
      chain: [reference.file],
    })
  }

  const unusedAllowances = [...allowed.keys()].filter((path) => !chains.has(path) && !seeds.includes(path)).sort()
  for (const unused of unusedAllowances) {
    violations.push({
      reason: GRADER_TRUTH_REACHABLE,
      file: unused,
      line: 0,
      rule: 'ancestor_allowance_unused',
      detail: `allowed ancestor "${unused}" no longer reaches grader truth; a surplus allowance is a standing permission nobody reviewed`,
      chain: [],
    })
  }

  return {
    ok: violations.length === 0,
    reason: violations.length === 0 ? null : violations[0].reason,
    configProblems: [],
    seeds,
    ancestors: [...chains.keys()].sort(),
    dedicatedAncestors: [...chains.keys()].filter((file) => !mixedRouters.has(file)).sort(),
    mixedRouters: [...mixedRouters].sort(),
    graderReachable: [...graderReachable].sort(),
    dataReferences,
    computedSpecifiers: computed,
    routerEdges,
    unusedAllowances,
    unusedRouterAllowances,
    unusedComputedAllowances,
    violations,
  }
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
 * stay true when the comment stops being.
 */
export function analyzeGraderSequencing(input = {}) {
  const root = input.root ?? process.cwd()
  const config = loadConfig(root, input.config)
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
    const sourceFile = ts.createSourceFile(absolute, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
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

      // The loader result may be wrapped (it is: a row profile is selected).
      // Every wrapper on the way to the binding must be an approved consumer.
      let binding = null
      for (let current = loaderCall.parent; current; current = current.parent) {
        if (ts.isCallExpression(current)) {
          const wrapper = calleeName(current)
          site.wrappers.push(wrapper)
          if (!approvedConsumers.has(wrapper)) {
            problems.push(`${relative_}:${lineOf(current)} wraps grader truth in "${wrapper}", which is not an approved grader consumer`)
          }
          continue
        }
        if (ts.isVariableDeclaration(current)) { binding = current; break }
        if (ts.isExpressionStatement(current) || ts.isBlock(current) || current === scope) break
      }

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

export function formatGraderBoundaryReport(result) {
  if (result.configProblems?.length > 0) {
    return ['Grader boundary configuration is invalid:', ...result.configProblems.map((problem) => `  - ${problem}`)].join('\n')
  }
  if (result.ok) {
    return [
      `Grader boundary OK. Seed(s): ${result.seeds.join(', ')}`,
      `Dedicated grader/benchmark ancestors: ${result.dedicatedAncestors.length}`,
      ...result.dedicatedAncestors.map((file) => `  - ${file}`),
      `Mixed command routers (never trusted as whole files): ${result.mixedRouters.length}`,
      ...result.mixedRouters.map((file) => `  - ${file}`),
      `Mixed-router grader edges (exact): ${result.routerEdges.length}`,
      ...result.routerEdges.map((edge) => (
        `  - ${edge.from}:${edge.line} --${edge.kind}--> ${edge.resolved}  '${edge.specifier}'  [${edge.imported_bindings.join(', ')}]`
      )),
      `Computed dynamic import sites (exact): ${result.computedSpecifiers.length}`,
      ...result.computedSpecifiers.map((site) => (
        `  - ${site.path}:${site.line} ${site.enclosing_declaration} :: ${site.expression}`
      )),
    ].join('\n')
  }
  const grouped = new Map()
  for (const violation of result.violations) {
    if (!grouped.has(violation.reason)) grouped.set(violation.reason, [])
    grouped.get(violation.reason).push(violation)
  }
  const lines = []
  for (const [reason, entries] of grouped) {
    lines.push(`${reason}: ${entries.length} violation(s).`)
    for (const violation of entries) {
      lines.push('')
      lines.push(`  ${violation.file}:${violation.line}  [${violation.rule}]`)
      lines.push(`    ${violation.detail}`)
      if (violation.chain.length > 0) lines.push(`    reach: ${violation.chain.join(' -> ')}`)
    }
    lines.push('')
  }
  lines.push('Remedy: move the shared code into a module that does not depend on the grader, or add')
  lines.push('an exact justified entry to docs/architecture/grader-boundary.json. Normal product roots')
  lines.push('can never be allowlisted; mixed routers are approved edge by edge; computed imports are')
  lines.push('approved call site by call site.')
  return lines.join('\n')
}
