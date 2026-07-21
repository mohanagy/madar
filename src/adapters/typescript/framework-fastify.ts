import ts from 'typescript'

import type { IndexSymbol } from '../../domain/index/model.js'
import {
  emitFrameworkEdge,
  mergeFrameworkMetadata,
  resolveOrMintHandler,
  resolvedDeclaration,
  stringValue,
  tagLocal,
  type FrameworkHttpContext,
} from './framework-http.js'

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all'])

export type DetectFastifyFrameworkContext = FrameworkHttpContext

type Receiver = { name: string; owner: IndexSymbol; declaration?: ts.Declaration }
type FastifyBindings = { factories: Set<string>; instances: Set<string>; plugins: Set<string>; namespaces: Set<string> }

export function detectFastifyFramework(ctx: DetectFastifyFrameworkContext): void {
  const bindings = collectBindings(ctx.sourceFile)
  const receivers: Receiver[] = []

  forEachVariable(ctx.sourceFile, (decl) => {
    if (!decl.initializer || !isFactoryCall(decl.initializer, bindings.factories)) return
    const app = tagLocal(ctx, decl.name.text, 'fastify_app')
    if (app) receivers.push({ name: decl.name.text, owner: app, declaration: decl })
  })
  collectStandalonePlugins(ctx, bindings, receivers)
  if (receivers.length === 0) return

  const registerVisit = (node: ts.Node): void => {
    const matched = receiverCall(node, receivers, ctx, 'register')
    if (matched) {
      const arg = matched.call.arguments[0]
      const plugin = arg ? resolveOrMintHandler(ctx, arg, 'fastify', 'fastify_plugin') : null
      if (plugin) {
        const prefix = objectStringProperty(matched.call.arguments[1], 'prefix')
        mergeFrameworkMetadata(plugin, prefix === null ? {} : { mount_path: prefix })
        emitFrameworkEdge(ctx, matched.receiver.owner, plugin, matched.call, prefix === null ? {} : { mount_path: prefix })
        const parameter = firstParameter(resolvedDeclaration(arg, ctx.checker))
        if (parameter && ts.isIdentifier(parameter.name)) {
          receivers.push({ name: parameter.name.text, owner: plugin, declaration: parameter })
        }
      }
    }
    ts.forEachChild(node, registerVisit)
  }
  registerVisit(ctx.sourceFile)

  const routeVisit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text
      if (HTTP_METHODS.has(method)) {
        const receiver = matchReceiver(node.expression.expression, receivers, ctx)
        const path = stringValue(node.arguments[0])
        const arg = node.arguments.at(-1)
        const handler = receiver && path !== null && arg
          ? resolveOrMintHandler(ctx, arg, 'fastify', 'fastify_route')
          : null
        if (receiver && handler) {
          const metadata = { route_path: path, http_method: method.toUpperCase() }
          mergeFrameworkMetadata(handler, metadata)
          emitFrameworkEdge(ctx, receiver.owner, handler, node, metadata)
        }
      }
    }
    ts.forEachChild(node, routeVisit)
  }
  routeVisit(ctx.sourceFile)
}

function collectBindings(sourceFile: ts.SourceFile): FastifyBindings {
  const bindings: FastifyBindings = { factories: new Set(), instances: new Set(), plugins: new Set(), namespaces: new Set() }
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
    if (stmt.moduleSpecifier.text !== 'fastify') continue
    if (stmt.importClause.name) bindings.factories.add(stmt.importClause.name.text)
    const named = stmt.importClause.namedBindings
    if (named && ts.isNamespaceImport(named)) {
      bindings.namespaces.add(named.name.text)
      continue
    }
    if (!named || !ts.isNamedImports(named)) continue
    for (const element of named.elements) {
      const imported = element.propertyName?.text ?? element.name.text
      if (imported === 'fastify' || imported === 'default') bindings.factories.add(element.name.text)
      if (imported === 'FastifyInstance') bindings.instances.add(element.name.text)
      if (imported === 'FastifyPluginAsync') bindings.plugins.add(element.name.text)
    }
  }
  let changed = true
  while (changed) {
    changed = false
    for (const stmt of sourceFile.statements) {
      if (!ts.isTypeAliasDeclaration(stmt)) continue
      if (!bindings.instances.has(stmt.name.text) && isInstanceType(stmt.type, bindings)) {
        bindings.instances.add(stmt.name.text)
        changed = true
      }
      if (!bindings.plugins.has(stmt.name.text) && isPluginType(stmt.type, bindings)) {
        bindings.plugins.add(stmt.name.text)
        changed = true
      }
    }
  }
  return bindings
}

function collectStandalonePlugins(
  ctx: DetectFastifyFrameworkContext,
  bindings: FastifyBindings,
  receivers: Receiver[],
): void {
  const add = (name: string, parameter: ts.ParameterDeclaration | undefined): void => {
    if (!parameter || !ts.isIdentifier(parameter.name) || !parameter.type || !isInstanceType(parameter.type, bindings)) return
    const plugin = tagLocal(ctx, name, 'fastify_plugin')
    if (plugin) receivers.push({ name: parameter.name.text, owner: plugin, declaration: parameter })
  }
  const addTyped = (decl: ts.VariableDeclaration, name: string): boolean => {
    if (!decl.type || !isPluginType(decl.type, bindings) || !decl.initializer) return false
    if (!ts.isArrowFunction(decl.initializer) && !ts.isFunctionExpression(decl.initializer)) return false
    const parameter = decl.initializer.parameters[0]
    if (!parameter || !ts.isIdentifier(parameter.name)) return false
    const plugin = tagLocal(ctx, name, 'fastify_plugin')
    if (plugin) receivers.push({ name: parameter.name.text, owner: plugin, declaration: parameter })
    return true
  }
  for (const stmt of ctx.sourceFile.statements) {
    if (!hasExportModifier(stmt)) continue
    if (ts.isFunctionDeclaration(stmt) && stmt.name) add(stmt.name.text, stmt.parameters[0])
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
      if (addTyped(decl, decl.name.text)) continue
      if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
        add(decl.name.text, decl.initializer.parameters[0])
      }
    }
  }
}

function isPluginType(type: ts.TypeNode, bindings: FastifyBindings): boolean {
  if (ts.isTypeReferenceNode(type)) {
    if (ts.isIdentifier(type.typeName)) return bindings.plugins.has(type.typeName.text)
    return ts.isIdentifier(type.typeName.left)
      && bindings.namespaces.has(type.typeName.left.text)
      && type.typeName.right.text === 'FastifyPluginAsync'
  }
  return ts.isImportTypeNode(type)
    && ts.isLiteralTypeNode(type.argument)
    && ts.isStringLiteral(type.argument.literal)
    && type.argument.literal.text === 'fastify'
    && !!type.qualifier
    && ts.isIdentifier(type.qualifier)
    && type.qualifier.text === 'FastifyPluginAsync'
}

function isInstanceType(type: ts.TypeNode, bindings: FastifyBindings): boolean {
  if (ts.isTypeReferenceNode(type)) {
    if (ts.isIdentifier(type.typeName)) return bindings.instances.has(type.typeName.text)
    return ts.isIdentifier(type.typeName.left)
      && bindings.namespaces.has(type.typeName.left.text)
      && type.typeName.right.text === 'FastifyInstance'
  }
  return ts.isImportTypeNode(type)
    && ts.isLiteralTypeNode(type.argument)
    && ts.isStringLiteral(type.argument.literal)
    && type.argument.literal.text === 'fastify'
    && !!type.qualifier
    && ts.isIdentifier(type.qualifier)
    && type.qualifier.text === 'FastifyInstance'
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.getModifiers(node as ts.HasModifiers)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

function forEachVariable(sourceFile: ts.SourceFile, visit: (decl: ts.VariableDeclaration & { name: ts.Identifier }) => void): void {
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name)) visit(decl as ts.VariableDeclaration & { name: ts.Identifier })
    }
  }
}

function isFactoryCall(expr: ts.Expression, factories: ReadonlySet<string>): boolean {
  return ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && factories.has(expr.expression.text)
}

function receiverCall(
  node: ts.Node,
  receivers: readonly Receiver[],
  ctx: DetectFastifyFrameworkContext,
  member: string,
): { call: ts.CallExpression; receiver: Receiver } | null {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null
  if (node.expression.name.text !== member) return null
  const receiver = matchReceiver(node.expression.expression, receivers, ctx)
  return receiver ? { call: node, receiver } : null
}

function matchReceiver(expr: ts.Expression, receivers: readonly Receiver[], ctx: DetectFastifyFrameworkContext): Receiver | null {
  if (!ts.isIdentifier(expr)) return null
  const declaration = resolvedDeclaration(expr, ctx.checker)
  return receivers.find((candidate) =>
    candidate.name === expr.text && (!candidate.declaration || declaration === candidate.declaration),
  ) ?? null
}

function firstParameter(decl: ts.Declaration | undefined): ts.ParameterDeclaration | null {
  if (decl && ts.isFunctionDeclaration(decl)) return decl.parameters[0] ?? null
  if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
    const init = decl.initializer
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init.parameters[0] ?? null
  }
  return null
}

function objectStringProperty(expr: ts.Expression | undefined, name: string): string | null {
  if (!expr || !ts.isObjectLiteralExpression(expr)) return null
  for (const prop of expr.properties) {
    if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)) && prop.name.text === name) {
      return stringValue(prop.initializer)
    }
  }
  return null
}
