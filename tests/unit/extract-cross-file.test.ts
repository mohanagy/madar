import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { ExtractionData, ExtractionNode } from '../../src/pipeline/extract/contracts.js'
import { resolveCrossFilePythonImports } from '../../src/pipeline/extract/cross-file.js'

function createTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'madar-extract-cross-file-'))
}

describe('resolveCrossFilePythonImports', () => {
  it('adds inferred cross-file calls for imported python functions', () => {
    const root = createTempRoot()
    try {
      const helpersPath = join(root, 'helpers.py')
      const authPath = join(root, 'auth.py')

      writeFileSync(helpersPath, ['def normalize_token(value):', '    return value.strip().lower()'].join('\n'), 'utf8')
      writeFileSync(
        authPath,
        [
          'from .helpers import normalize_token',
          '',
          'class DigestAuth:',
          '    def build(self, token):',
          '        return normalize_token(token)',
        ].join('\n'),
        'utf8',
      )

      const resolved = resolveCrossFilePythonImports([authPath, helpersPath], {
        nodes: [
          { id: 'auth_digestauth', label: 'DigestAuth', file_type: 'code', source_file: authPath },
          { id: 'auth_digestauth_build', label: '.build()', file_type: 'code', source_file: authPath },
          { id: 'helpers_normalize_token', label: 'normalize_token()', file_type: 'code', source_file: helpersPath },
        ],
        edges: [
          { source: 'auth_digestauth', target: 'auth_digestauth_build', relation: 'method', confidence: 'EXTRACTED', source_file: authPath },
        ],
        input_tokens: 0,
        output_tokens: 0,
      })

      expect(resolved.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: 'auth_digestauth_build',
            target: 'helpers_normalize_token',
            relation: 'calls',
            confidence: 'INFERRED',
          }),
        ]),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('adds inferred cross-file calls for imported async python functions', () => {
    const root = createTempRoot()
    try {
      const helpersPath = join(root, 'helpers.py')
      const authPath = join(root, 'auth.py')

      writeFileSync(helpersPath, ['def normalize_token(value):', '    return value.strip().lower()'].join('\n'), 'utf8')
      writeFileSync(
        authPath,
        [
          'from .helpers import normalize_token',
          '',
          'class DigestAuth:',
          '    async def build(self, token):',
          '        return normalize_token(token)',
        ].join('\n'),
        'utf8',
      )

      const resolved = resolveCrossFilePythonImports([authPath, helpersPath], {
        nodes: [
          { id: 'auth_digestauth', label: 'DigestAuth', file_type: 'code', source_file: authPath },
          { id: 'auth_digestauth_build', label: '.build()', file_type: 'code', source_file: authPath },
          { id: 'helpers_normalize_token', label: 'normalize_token()', file_type: 'code', source_file: helpersPath },
        ],
        edges: [
          { source: 'auth_digestauth', target: 'auth_digestauth_build', relation: 'method', confidence: 'EXTRACTED', source_file: authPath },
        ],
        input_tokens: 0,
        output_tokens: 0,
      })

      expect(resolved.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: 'auth_digestauth_build',
            target: 'helpers_normalize_token',
            relation: 'calls',
            confidence: 'INFERRED',
          }),
        ]),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('skips inferred cross-file calls when the nested python function node is missing', () => {
    const root = createTempRoot()
    try {
      const helpersPath = join(root, 'helpers.py')
      const authPath = join(root, 'auth.py')

      writeFileSync(helpersPath, ['def normalize_token(value):', '    return value.strip().lower()'].join('\n'), 'utf8')
      writeFileSync(
        authPath,
        [
          'from .helpers import normalize_token',
          '',
          'def outer(token):',
          '    def inner():',
          '        return normalize_token(token)',
          '    return inner()',
        ].join('\n'),
        'utf8',
      )

      const resolved = resolveCrossFilePythonImports([authPath, helpersPath], {
        nodes: [
          { id: 'auth_outer', label: 'outer()', file_type: 'code', source_file: authPath },
          { id: 'helpers_normalize_token', label: 'normalize_token()', file_type: 'code', source_file: helpersPath },
        ],
        edges: [],
        input_tokens: 0,
        output_tokens: 0,
      })

      expect(resolved.edges.some((edge) => edge.target === 'helpers_normalize_token' && edge.relation === 'calls')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('adds inferred inherits and uses edges across python files', () => {
    const root = createTempRoot()
    try {
      const modelsPath = join(root, 'models.py')
      const authPath = join(root, 'auth.py')

      writeFileSync(modelsPath, ['class Response:', '    pass', '', 'class BaseAuth:', '    pass'].join('\n'), 'utf8')
      writeFileSync(
        authPath,
        [
          'from .models import Response as ApiResponse, BaseAuth',
          '',
          'class DigestAuth(BaseAuth):',
          '    def build(self) -> ApiResponse:',
          '        return ApiResponse()',
        ].join('\n'),
        'utf8',
      )

      const resolved = resolveCrossFilePythonImports([authPath, modelsPath], {
        nodes: [
          { id: 'auth_digestauth', label: 'DigestAuth', file_type: 'code', source_file: authPath },
          { id: 'response', label: 'Response', file_type: 'code', source_file: modelsPath },
          { id: 'base', label: 'BaseAuth', file_type: 'code', source_file: modelsPath },
        ],
        edges: [],
        input_tokens: 0,
        output_tokens: 0,
      })

      expect(resolved.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'auth_digestauth', target: 'base', relation: 'inherits', confidence: 'INFERRED' }),
          expect.objectContaining({ source: 'auth_digestauth', target: 'response', relation: 'uses', confidence: 'INFERRED' }),
        ]),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('can resolve imported targets from context nodes without adding them to the returned extraction payload', () => {
    const root = createTempRoot()
    try {
      const modelsPath = join(root, 'models.py')
      const authPath = join(root, 'auth.py')

      writeFileSync(modelsPath, ['class Response:', '    pass', '', 'class BaseAuth:', '    pass'].join('\n'), 'utf8')
      writeFileSync(
        authPath,
        [
          'from .models import Response as ApiResponse, BaseAuth',
          '',
          'class DigestAuth(BaseAuth):',
          '    def build(self) -> ApiResponse:',
          '        return ApiResponse()',
        ].join('\n'),
        'utf8',
      )

      const combined: ExtractionData = {
        nodes: [{ id: 'auth_digestauth', label: 'DigestAuth', file_type: 'code', source_file: authPath }],
        edges: [],
        input_tokens: 0,
        output_tokens: 0,
      }
      const contextNodes: ExtractionNode[] = [
        { id: 'response', label: 'Response', file_type: 'code', source_file: modelsPath },
        { id: 'base', label: 'BaseAuth', file_type: 'code', source_file: modelsPath },
      ]

      const resolved = resolveCrossFilePythonImports([authPath, modelsPath], combined, { contextNodes })

      expect(resolved.nodes).toEqual(combined.nodes)
      expect(resolved.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'auth_digestauth', target: 'base', relation: 'inherits' }),
          expect.objectContaining({ source: 'auth_digestauth', target: 'response', relation: 'uses' }),
        ]),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('skips unreadable python files while still resolving links from readable files', () => {
    const root = createTempRoot()
    try {
      const missingModelsPath = join(root, 'models.py')
      const authPath = join(root, 'auth.py')

      writeFileSync(
        authPath,
        [
          'from .models import Response as ApiResponse, BaseAuth',
          '',
          'class DigestAuth(BaseAuth):',
          '    def build(self) -> ApiResponse:',
          '        return ApiResponse()',
        ].join('\n'),
        'utf8',
      )

      const resolved = resolveCrossFilePythonImports(
        [authPath, missingModelsPath],
        {
          nodes: [{ id: 'auth_digestauth', label: 'DigestAuth', file_type: 'code', source_file: authPath }],
          edges: [],
          input_tokens: 0,
          output_tokens: 0,
        },
        {
          contextNodes: [
            { id: 'response', label: 'Response', file_type: 'code', source_file: missingModelsPath },
            { id: 'base', label: 'BaseAuth', file_type: 'code', source_file: missingModelsPath },
          ],
        },
      )

      expect(resolved.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'auth_digestauth', target: 'base', relation: 'inherits' }),
          expect.objectContaining({ source: 'auth_digestauth', target: 'response', relation: 'uses' }),
        ]),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
