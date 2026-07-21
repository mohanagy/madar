import { dirname, resolve } from 'node:path'

import type { HandoffCliOptions } from '../cli/parser.js'
import type { ContextPackSchemaV1 } from '../contracts/context-pack.js'
import type { HandoffArtifactSchemaV1, HandoffConsumer } from '../contracts/handoff.js'
import type { KnowledgeGraph } from '../domain/graph/directed-multigraph.js'
import {
  runContextPackCommand,
  type ContextPackCommandDependencies,
} from './context-pack-command.js'
import {
  sanitizeShareSafeText,
  toShareSafeArtifactPath,
  type ShareSafePathRoots,
} from '../shared/share-safe-artifacts.js'
import { resolveWorkspaceGraphPath } from '../shared/workspace.js'
import { loadGraph } from '../runtime/serve.js'

export interface HandoffArtifactBuildOptions {
  consumer: HandoffConsumer
  artifactRoot: string
  projectRoot: string
  allowSnippets?: boolean
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

const PATH_KEYS = new Set([
  'graph_path',
  'path',
  'source_file',
  'target_file',
])

const PATH_ARRAY_KEYS = new Set([
  'affected_files',
  'changed_files',
  'covered_workflow_owners',
  'excluded_path_hints',
  'focus_files',
  'mentioned_paths',
  'path_hints',
  'supporting_paths',
  'test_paths',
])

const TEXT_KEYS = new Set([
  'boundary_reason',
  'prompt',
  'question',
  'reason',
  'representation_reason',
  'summary',
  'text',
  'why',
])

const TEXT_ARRAY_KEYS = new Set([
  'confidence_reasons',
  'negative_guidance',
  'validation_commands',
  'why_explanation',
])

const SECRET_ENV_ASSIGNMENT_PATTERN = /\b([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASS|PWD))=(?:"[^"]*"|'[^']*'|[^\s"'`]+)/g
const AUTH_HEADER_PATTERN = /\b(Authorization:\s*(?:Bearer|Basic)\s+)[^\s"'`]+/gi
const SECRET_QUERY_PARAM_PATTERN = /([?&](?:access_token|api[_-]?key|auth|key|password|refresh_token|secret|token)=)[^&#\s]+/gi
const URL_USERINFO_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)([^\/\s@]+)@/gi

function redactHandoffSecrets(text: string): string {
  return text
    .replace(SECRET_ENV_ASSIGNMENT_PATTERN, '$1=<redacted>')
    .replace(AUTH_HEADER_PATTERN, '$1<redacted>')
    .replace(URL_USERINFO_PATTERN, '$1<redacted>@')
    .replace(SECRET_QUERY_PARAM_PATTERN, '$1<redacted>')
}

function sanitizeHandoffText(text: string, roots: ShareSafePathRoots): string {
  return redactHandoffSecrets(sanitizeShareSafeText(text, roots))
}

function sanitizeStringValue(key: string, value: string, roots: ShareSafePathRoots): string {
  if (PATH_KEYS.has(key)) {
    return toShareSafeArtifactPath(value, roots)
  }
  if (TEXT_KEYS.has(key) || TEXT_ARRAY_KEYS.has(key)) {
    return sanitizeHandoffText(value, roots)
  }
  return value
}

function sanitizeJsonValue(
  value: JsonValue,
  roots: ShareSafePathRoots,
  options: { allowSnippets: boolean; parentKey?: string } = { allowSnippets: false },
): JsonValue {
  if (typeof value === 'string') {
    if (options.parentKey && PATH_ARRAY_KEYS.has(options.parentKey)) {
      return toShareSafeArtifactPath(value, roots)
    }
    if (options.parentKey && TEXT_ARRAY_KEYS.has(options.parentKey)) {
      return sanitizeHandoffText(value, roots)
    }
    return options.parentKey ? sanitizeStringValue(options.parentKey, value, roots) : value
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeJsonValue(entry, roots, options))
  }

  if (value === null || typeof value !== 'object') {
    return value
  }

  const sanitizedEntries: Array<[string, JsonValue]> = []
  for (const [key, entry] of Object.entries(value)) {
    if (!options.allowSnippets && key === 'snippet') {
      continue
    }
    sanitizedEntries.push([
      key,
      sanitizeJsonValue(entry as JsonValue, roots, {
        allowSnippets: options.allowSnippets,
        parentKey: key,
      }),
    ])
  }
  return Object.fromEntries(sanitizedEntries)
}

function asJsonValue<TPack>(value: TPack): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function sanitizeObjectValue<T extends object>(
  value: T,
  roots: ShareSafePathRoots,
  options: { allowSnippets: boolean },
): T {
  const sanitized = sanitizeJsonValue(asJsonValue(value), roots, options)
  if (sanitized === null || Array.isArray(sanitized) || typeof sanitized !== 'object') {
    throw new Error('Expected sanitized handoff payload to remain an object')
  }
  return sanitized as T
}

function buildShareSafeRoots(options: Pick<HandoffArtifactBuildOptions, 'artifactRoot' | 'projectRoot'>): ShareSafePathRoots {
  return {
    artifactRoot: resolve(options.artifactRoot),
    projectRoot: resolve(options.projectRoot),
  }
}

export function buildHandoffArtifactV1<TPack>(
  schema: ContextPackSchemaV1<TPack>,
  options: HandoffArtifactBuildOptions,
): HandoffArtifactSchemaV1<TPack> {
  const { plan: _plan, ...rest } = schema
  const roots = buildShareSafeRoots(options)
  const sanitized = sanitizeObjectValue(rest, roots, {
    allowSnippets: options.allowSnippets === true,
  })

  return {
    artifact_kind: 'madar_handoff',
    consumer: options.consumer,
    share_safe: options.allowSnippets !== true,
    snippet_policy: options.allowSnippets === true ? 'include' : 'omit',
    ...sanitized,
  }
}

export interface HandoffCommandDependencies extends Partial<ContextPackCommandDependencies> {
  loadGraph?: (graphPath: string) => KnowledgeGraph
  runContextPackCommand?: (options: {
    prompt: string
    budget: number
    task: HandoffCliOptions['task']
    graphPath: string
    format: 'json'
    verbose: true
    requireFreshGraph?: boolean
    requireFreshContext?: boolean
  }) => Promise<string>
}

function hasContextPackDependencyOverrides(
  dependencies: HandoffCommandDependencies,
): dependencies is ContextPackCommandDependencies & HandoffCommandDependencies {
  return typeof dependencies.loadGraph === 'function'
    && typeof dependencies.retrieveContext === 'function'
    && typeof dependencies.compactRetrieveResult === 'function'
    && typeof dependencies.analyzePrImpact === 'function'
    && typeof dependencies.compactPrImpactResult === 'function'
    && typeof dependencies.analyzeImpact === 'function'
    && typeof dependencies.compactImpactResult === 'function'
}

export async function runHandoffCommand(
  options: HandoffCliOptions,
  dependencies: HandoffCommandDependencies = {},
): Promise<string> {
  const loadGraphDependency = dependencies.loadGraph ?? loadGraph
  const graphPath = resolveWorkspaceGraphPath(options.graphPath)
  const graph = loadGraphDependency(graphPath)
  const packOptions = {
    prompt: options.prompt,
    budget: options.budget,
    task: options.task,
    graphPath,
    format: 'json',
    verbose: true,
    ...(options.requireFreshGraph === true ? { requireFreshGraph: true } : {}),
    ...(options.requireFreshContext === true ? { requireFreshContext: true } : {}),
  } as const
  const contextPackPayload = dependencies.runContextPackCommand
    ? await dependencies.runContextPackCommand(packOptions)
    : hasContextPackDependencyOverrides(dependencies)
      ? await runContextPackCommand(packOptions, dependencies)
      : await runContextPackCommand(packOptions)

  const schema = JSON.parse(contextPackPayload) as ContextPackSchemaV1<unknown>
  // The pack payload may preserve the caller's relative graph argument. Bind
  // it to the physical graph selected for this command so linked worktrees
  // receive the correct share-safe artifact-root placeholder.
  const artifact = buildHandoffArtifactV1({
    ...schema,
    graph_path: resolve(graphPath),
  }, {
    consumer: options.consumer,
    artifactRoot: dirname(resolve(graphPath)),
    projectRoot: typeof graph.graph.root_path === 'string' && graph.graph.root_path.trim().length > 0
      ? graph.graph.root_path
      : process.cwd(),
    ...(options.allowSnippets === true ? { allowSnippets: true } : {}),
  })
  return JSON.stringify(artifact)
}
