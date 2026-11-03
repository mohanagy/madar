import { createHash } from 'node:crypto'
import ts from 'typescript'
import { _makeId, makeTsMemberId } from './core.js'

export interface TopLevelIdentityEntry { name: string; kind: string; baseId: string }
export interface TopLevelCasePlan {
  ids: Map<string, string>
  affectedNames: Set<string>
  logicalOwners: Map<string, string>
}
export const declarationIdentityKey = (kind: string, name: string): string => `${kind}\0${name}`

/** Preserve ordinary IDs and exact-name merges; allocate only unique case-only function/interface groups. */
export function allocateTopLevelCaseIdentities(entries: readonly TopLevelIdentityEntry[], reserved: Iterable<string> = []): TopLevelCasePlan {
  const groups = new Map<string, TopLevelIdentityEntry[]>()
  const occupied = new Set([...reserved, ...entries.map(entry => entry.baseId)])
  for (const entry of entries) {
    const group = groups.get(entry.baseId) ?? []
    group.push(entry); groups.set(entry.baseId, group)
  }
  const plan: TopLevelCasePlan = { ids: new Map(), affectedNames: new Set(), logicalOwners: new Map() }
  for (const [baseId, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    if (group.length < 2 || !group.some(entry => entry.kind === 'function')
      || group.some(entry => entry.kind !== 'function' && entry.kind !== 'interface')
      || new Set(group.map(entry => entry.name)).size !== group.length
      || group.some(entry => entry.name.toLowerCase() !== group[0]!.name.toLowerCase())) continue
    const allocated = group.map(entry => ({ entry, id: `${baseId}__case_${createHash('sha256')
      .update(declarationIdentityKey(entry.kind, entry.name)).digest('hex').slice(0, 16)}` }))
    if (new Set(allocated.map(entry => entry.id)).size !== allocated.length
      || allocated.some(entry => occupied.has(entry.id))) continue
    for (const { entry, id } of allocated) {
      plan.ids.set(declarationIdentityKey(entry.kind, entry.name), id)
      plan.affectedNames.add(entry.name.toLowerCase())
      plan.logicalOwners.set(id, baseId); occupied.add(id)
    }
  }
  return plan
}

/** Include unsupported declarations too, so filtering cannot manufacture an eligible group. */
export function topLevelCaseIdentityPlan(source: ts.SourceFile, stem: string): TopLevelCasePlan {
  const entries: TopLevelIdentityEntry[] = []
  const add = (name: string, kind: string) => entries.push({ name, kind, baseId: _makeId(stem, name) })
  for (const node of source.statements) {
    if (ts.isFunctionDeclaration(node) && node.name) add(node.name.text, 'function')
    else if (ts.isInterfaceDeclaration(node)) add(node.name.text, 'interface')
    else if (ts.isClassDeclaration(node) && node.name) add(node.name.text, 'class')
    else if (ts.isTypeAliasDeclaration(node)) add(node.name.text, 'type-alias')
    else if (ts.isEnumDeclaration(node)) add(node.name.text, 'enum')
    else if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) add(node.name.text, 'namespace')
    else if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) add(declaration.name.text, 'variable')
    }
  }
  // Other projected owners reserve their old identity but never gain allocation here.
  const ownerName = (node: ts.Node): string | undefined => {
    if (ts.isConstructorDeclaration(node)) return 'constructor'
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isMethodDeclaration(node))
      && node.name && (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name))) return node.name.text
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent)
      && ts.isIdentifier(node.parent.name)) return node.parent.name.text
    return undefined
  }
  const visit = (node: ts.Node): void => {
    const named = (ts.isFunctionDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)
      || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)
      || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node))
      && node.name && (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name)) ? node.name.text
      : ts.isConstructorDeclaration(node) ? 'constructor'
        : ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
          && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) ? node.name.text : undefined
    const alreadyTopLevel = ts.isSourceFile(node.parent)
      || (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent)
        && ts.isVariableStatement(node.parent.parent) && ts.isSourceFile(node.parent.parent.parent))
    if (named && !alreadyTopLevel) {
      const owners: string[] = []
      for (let parent = node.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) {
        const name = ownerName(parent); if (name) owners.unshift(name)
      }
      const baseId = named.startsWith('#') ? makeTsMemberId(_makeId(stem, ...owners), named, true) : _makeId(stem, ...owners, named)
      entries.push({ name: [...owners, named].join('.'), kind: 'unsupported', baseId })
    }
    if (ts.isImportDeclaration(node) && node.importClause) {
      const clause = node.importClause
      if (clause.name) add(clause.name.text, 'import')
      const bindings = clause.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) add(bindings.name.text, 'import')
      else if (bindings) for (const binding of bindings.elements) add(binding.name.text, 'import')
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.getText(source)
      entries.push({ name, kind: 'unsupported', baseId: _makeId(stem, name) })
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return allocateTopLevelCaseIdentities(entries, [_makeId(stem)])
}

/** Conservative lexical check for the affected bare calls only; nested binding uncertainty abstains. */
export function affectedCallIsUnshadowed(call: ts.Node, name: string): boolean {
  const boundName = (binding: ts.BindingName): boolean => ts.isIdentifier(binding) ? binding.text === name
    : binding.elements.some(element => !ts.isOmittedExpression(element) && boundName(element.name))
  for (let scope: ts.Node = call.parent; !ts.isSourceFile(scope); scope = scope.parent) {
    if (!ts.isFunctionLike(scope) && !ts.isBlock(scope) && !ts.isCatchClause(scope)) continue
    let shadowed = false
    const visit = (node: ts.Node): void => {
      if (shadowed) return
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) && boundName(node.name)) shadowed = true
      if (node !== scope && (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.text === name) shadowed = true
      if (node === scope && ts.isFunctionExpression(node) && node.name?.text === name) shadowed = true
      ts.forEachChild(node, visit)
    }
    visit(scope)
    if (shadowed) return false
  }
  return true
}
