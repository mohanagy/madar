import { describe, expect, it } from 'vitest'

import type { RuntimeProofProfile } from '../../src/contracts/runtime-proof.js'
import { buildRuntimeProofAssessment, runtimeProofProvidesDirectEvidence } from '../../src/runtime/runtime-proof.js'

describe('runtime-proof terminal evidence', () => {
  const profile: RuntimeProofProfile = {
    prompt: 'How does Twenty process a CRM record mutation from API handling through workspace services to persistence?',
    strict_runtime_proof: true,
    expected_spi: false,
    obligations: [
      {
        id: 'persistence',
        label: 'persistence',
        kind: 'terminal',
        evidence_terms: ['workspace update query builder'],
      },
    ],
  }

  it('treats terminal execute on a matching persistence source as direct evidence', () => {
    const candidate = {
      label: '.execute()',
      source_file: '/src/engine/twenty-orm/repository/workspace-update-query-builder.ts',
      line_number: 104,
      node_kind: 'method',
    }

    expect(runtimeProofProvidesDirectEvidence(candidate, profile.obligations[0]!)).toBe(true)
    expect(buildRuntimeProofAssessment(profile, [candidate])?.missing_obligations).toEqual([])
  })

  it('does not treat unrelated terminal handlers as direct evidence for a specific persistence source', () => {
    const candidate = {
      label: '.saveImapSmtpCaldavAccount()',
      source_file: '/src/engine/core-modules/imap-smtp-caldav-connection/imap-smtp-caldav-connection.resolver.ts',
      line_number: 74,
      node_kind: 'method',
    }

    expect(runtimeProofProvidesDirectEvidence(candidate, profile.obligations[0]!)).toBe(false)
  })
})

describe('runtime-proof literal symbol and route matching', () => {
  it('treats exact symbol terms literally instead of matching broader wrapper names', () => {
    const obligation: RuntimeProofProfile['obligations'][number] = {
      id: 'persistence',
      label: 'persistence',
      kind: 'terminal',
      evidence_terms: ['createResponse()'],
    }

    expect(runtimeProofProvidesDirectEvidence({
      label: 'createResponse()',
      source_file: 'app/api/v2/client/[workspaceId]/responses/lib/response.ts',
      node_kind: 'function',
    }, obligation)).toBe(true)

    expect(runtimeProofProvidesDirectEvidence({
      label: 'createResponseWithQuotaEvaluation()',
      source_file: 'app/api/v2/client/[workspaceId]/responses/lib/response.ts',
      node_kind: 'function',
    }, obligation)).toBe(false)
  })

  it('accepts path-specific route helpers as direct entrypoint evidence', () => {
    const obligation: RuntimeProofProfile['obligations'][number] = {
      id: 'request_handling',
      label: 'request handling',
      kind: 'entrypoint',
      evidence_terms: [
        'app/api/v2/client/[workspaceId]/responses/route.ts',
        'createResponseForRequest()',
      ],
    }

    expect(runtimeProofProvidesDirectEvidence({
      label: 'createResponseForRequest()',
      source_file: 'app/api/v2/client/[workspaceId]/responses/route.ts',
      node_kind: 'function',
    }, obligation)).toBe(true)

    expect(runtimeProofProvidesDirectEvidence({
      label: 'POST /api/mcp',
      source_file: 'app/api/mcp/route.ts',
      node_kind: 'route',
      framework_role: 'next_route_handler',
    }, obligation)).toBe(false)
  })

  it('treats express handlers as direct entrypoint evidence', () => {
    const obligation: RuntimeProofProfile['obligations'][number] = {
      id: 'request_handling',
      label: 'request handling',
      kind: 'entrypoint',
      evidence_terms: ['showUser()'],
    }

    expect(runtimeProofProvidesDirectEvidence({
      label: 'showUser()',
      source_file: 'src/http/handlers.ts',
      node_kind: 'function',
      framework_role: 'express_handler',
    }, obligation)).toBe(true)
  })
})
