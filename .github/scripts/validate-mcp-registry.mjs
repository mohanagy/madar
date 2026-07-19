import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { strict as assert } from 'node:assert'

import Ajv from 'ajv'
import addFormats from 'ajv-formats'

const PACKAGE_JSON_PATH = resolve('package.json')
const REGISTRY_MANIFEST_PATH = resolve('docs/mcp-registry/server.json')
const REPOSITORY_ID = '1207912024'
const REPOSITORY_URL = 'https://github.com/mohanagy/madar'
const REGISTRY_NAME = 'io.github.mohanagy/madar'
const NPM_REGISTRY_URL = 'https://registry.npmjs.org'

const registryManifestSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['$schema', 'name', 'description', 'repository', 'version', 'packages'],
  properties: {
    $schema: {
      type: 'string',
      format: 'uri',
      pattern: '^https://static\\.modelcontextprotocol\\.io/schemas/.+/server\\.schema\\.json$',
    },
    name: {
      type: 'string',
      pattern: '^[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+$',
    },
    description: {
      type: 'string',
      minLength: 1,
      maxLength: 100,
    },
    title: {
      type: 'string',
      minLength: 1,
    },
    websiteUrl: {
      type: 'string',
      format: 'uri',
    },
    repository: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'source', 'url'],
      properties: {
        id: {
          type: 'string',
        },
        source: {
          const: 'github',
        },
        url: {
          const: REPOSITORY_URL,
        },
      },
    },
    version: {
      type: 'string',
      minLength: 1,
    },
    packages: {
      type: 'array',
      minItems: 1,
      maxItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['registryType', 'registryBaseUrl', 'identifier', 'version', 'runtimeHint', 'transport', 'packageArguments', 'environmentVariables'],
        properties: {
          registryType: {
            const: 'npm',
          },
          registryBaseUrl: {
            const: NPM_REGISTRY_URL,
          },
          identifier: {
            type: 'string',
            minLength: 1,
          },
          version: {
            type: 'string',
            minLength: 1,
          },
          runtimeHint: {
            const: 'npx',
          },
          transport: {
            type: 'object',
            additionalProperties: false,
            required: ['type'],
            properties: {
              type: {
                const: 'stdio',
              },
            },
          },
          packageArguments: {
            type: 'array',
            minItems: 3,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['type'],
              properties: {
                type: {
                  const: 'positional',
                },
                value: {
                  type: 'string',
                },
                valueHint: {
                  type: 'string',
                },
                description: {
                  type: 'string',
                },
                default: {
                  type: 'string',
                },
                format: {
                  type: 'string',
                },
                isRequired: {
                  type: 'boolean',
                },
              },
              oneOf: [
                { required: ['value'] },
                { required: ['valueHint'] },
              ],
            },
          },
          environmentVariables: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'description', 'default', 'choices'],
              properties: {
                name: {
                  type: 'string',
                },
                description: {
                  type: 'string',
                },
                default: {
                  type: 'string',
                },
                choices: {
                  type: 'array',
                  minItems: 1,
                  items: {
                    type: 'string',
                  },
                },
              },
            },
          },
        },
      },
    },
    _meta: {
      type: 'object',
      additionalProperties: false,
      properties: {
        'io.modelcontextprotocol.registry/publisher-provided': {
          type: 'object',
          additionalProperties: true,
        },
      },
    },
  },
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function main() {
  const packageManifest = loadJson(PACKAGE_JSON_PATH)
  const registryManifest = loadJson(REGISTRY_MANIFEST_PATH)
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true })
  addFormats(ajv)

  const validate = ajv.compile(registryManifestSchema)
  const valid = validate(registryManifest)
  if (!valid) {
    console.error('MCP Registry metadata schema validation failed.')
    console.error(JSON.stringify(validate.errors, null, 2))
    process.exit(1)
  }

  assert.equal(registryManifest.name, REGISTRY_NAME, 'server.json name must use the verified GitHub namespace')
  assert.equal(packageManifest.mcpName, REGISTRY_NAME, 'package.json mcpName must match the MCP Registry server name')
  assert.equal(registryManifest.repository.id, REPOSITORY_ID, 'server.json repository.id must match the GitHub repository id')
  assert.equal(registryManifest.version, packageManifest.version, 'server.json version must match package.json version')

  assert.equal(registryManifest.packages.length, 1, 'server.json must define exactly one npm package entry')
  const [npmPackage] = registryManifest.packages
  assert.equal(npmPackage.identifier, packageManifest.name, 'server.json package identifier must match package.json name')
  assert.equal(npmPackage.version, packageManifest.version, 'server.json package version must match package.json version')

  const packageArguments = npmPackage.packageArguments ?? []
  assert.deepEqual(
    packageArguments.map((entry) => entry.value ?? entry.valueHint ?? null),
    ['serve', '--stdio', '--auto-refresh'],
    'server.json package arguments must model `madar serve --stdio --auto-refresh`',
  )

  const graphPathArgument = packageArguments.find((entry) => entry.valueHint === 'graph_path')
  assert.equal(graphPathArgument, undefined, 'server.json must not pin the MCP server to a static graph_path argument')

  const toolProfile = (npmPackage.environmentVariables ?? []).find((entry) => entry.name === 'MADAR_TOOL_PROFILE')
  assert.ok(toolProfile, 'server.json must describe the MADAR_TOOL_PROFILE environment variable')
  assert.equal(toolProfile.default, 'core', 'MADAR_TOOL_PROFILE should default to core')
  assert.deepEqual(toolProfile.choices, ['core', 'strict', 'full'], 'MADAR_TOOL_PROFILE choices must match the supported MCP tool profiles')

  console.log(`Validated ${REGISTRY_MANIFEST_PATH} against the pinned MCP Registry manifest rules.`)
}

main()
