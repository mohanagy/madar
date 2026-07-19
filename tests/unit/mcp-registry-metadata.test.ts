import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

interface PackageManifest {
  mcpName?: string
  name?: string
  scripts?: Record<string, string>
  version?: string
}

interface RegistryEnvironmentVariable {
  name?: string
  description?: string
  default?: string
  choices?: string[]
}

interface RegistryPackageArgument {
  type?: string
  value?: string
  valueHint?: string
  default?: string
  description?: string
  format?: string
  isRequired?: boolean
}

interface RegistryPackage {
  registryType?: string
  registryBaseUrl?: string
  identifier?: string
  version?: string
  runtimeHint?: string
  transport?: {
    type?: string
  }
  packageArguments?: RegistryPackageArgument[]
  environmentVariables?: RegistryEnvironmentVariable[]
}

interface RegistryManifest {
  $schema?: string
  name?: string
  description?: string
  _meta?: {
    'io.modelcontextprotocol.registry/publisher-provided'?: {
      notes?: string
      source?: string
    }
  }
  repository?: {
    id?: string
    source?: string
    url?: string
  }
  version?: string
  packages?: RegistryPackage[]
}

interface PublishWorkflowStep {
  name?: string
  uses?: string
  run?: string
  with?: Record<string, unknown>
  'working-directory'?: string
}

interface PublishWorkflow {
  on?: {
    workflow_dispatch?: {
      inputs?: {
        release_tag?: {
          required?: boolean
          type?: string
        }
      }
    }
  }
  jobs?: {
    publish?: {
      permissions?: Record<string, string>
      steps?: PublishWorkflowStep[]
    }
  }
}

function loadPackageManifest(): PackageManifest {
  return JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as PackageManifest
}

function loadRegistryManifest(): RegistryManifest {
  return JSON.parse(readFileSync(resolve('docs/mcp-registry/server.json'), 'utf8')) as RegistryManifest
}

function loadPublishWorkflow(): string {
  return readFileSync(resolve('.github/workflows/publish-mcp-registry.yml'), 'utf8')
}

function parsePublishWorkflow(): PublishWorkflow {
  return parse(loadPublishWorkflow()) as PublishWorkflow
}

function publishWorkflowStep(workflow: PublishWorkflow, name: string): PublishWorkflowStep {
  const step = workflow.jobs?.publish?.steps?.find((candidate) => candidate.name === name)
  if (!step) {
    throw new Error(`Missing publish workflow step: ${name}`)
  }
  return step
}

describe('MCP Registry metadata', () => {
  it('keeps the checked-in server.json aligned with the published Madar npm package and install flow', () => {
    expect(existsSync(resolve('docs/mcp-registry/server.json'))).toBe(true)

    const packageManifest = loadPackageManifest()
    const registryManifest = loadRegistryManifest()
    const npmPackage = registryManifest.packages?.[0]
    const graphPathArgument = npmPackage?.packageArguments?.find((entry) => entry.valueHint === 'graph_path')
    const toolProfile = npmPackage?.environmentVariables?.find((entry) => entry.name === 'MADAR_TOOL_PROFILE')
    const publisherNotes = registryManifest._meta?.['io.modelcontextprotocol.registry/publisher-provided']

    expect(registryManifest.$schema).toContain('static.modelcontextprotocol.io/schemas/')
    expect(registryManifest.name).toBe('io.github.mohanagy/madar')
    expect(packageManifest.mcpName).toBe(registryManifest.name)
    expect(registryManifest.description?.toLowerCase()).toContain('task-aware')
    expect(registryManifest.description?.toLowerCase()).toContain('typescript/node')
    expect(registryManifest.description?.toLowerCase()).toContain('local')
    expect(registryManifest.repository).toEqual({
      id: '1207912024',
      source: 'github',
      url: 'https://github.com/mohanagy/madar',
    })
    expect(registryManifest.version).toBe(packageManifest.version)
    expect(npmPackage).toMatchObject({
      registryType: 'npm',
      registryBaseUrl: 'https://registry.npmjs.org',
      identifier: packageManifest.name,
      version: packageManifest.version,
      runtimeHint: 'npx',
      transport: { type: 'stdio' },
    })
    expect(npmPackage?.packageArguments?.map((entry) => entry.value)).toEqual([
      'serve',
      '--stdio',
      '--auto-refresh',
    ])
    expect(graphPathArgument).toBeUndefined()
    expect(toolProfile).toMatchObject({
      name: 'MADAR_TOOL_PROFILE',
      default: 'core',
    })
    expect(toolProfile?.choices).toEqual(expect.arrayContaining(['core', 'strict', 'full']))
    expect(toolProfile?.description).toContain('strict bounded context_pack/context_expand')
    expect(publisherNotes?.source).toBe('docs/mcp-registry/server.json')
    expect(publisherNotes?.notes).toContain('When an MCP host launches')
    expect(publisherNotes?.notes).toContain('Madar is the renamed continuation of `graphify-ts`')
    expect(publisherNotes?.notes).toContain('`madar serve --stdio --auto-refresh`')
    expect(publisherNotes?.notes).toContain('`@lubab/madar`')
    expect(publisherNotes?.notes).toContain('`https://github.com/mohanagy/madar`')
  })

  it('exposes a repeatable local validation command for the checked-in registry metadata', () => {
    const packageManifest = loadPackageManifest()

    expect(packageManifest.scripts?.['registry:validate']).toBe('node .github/scripts/validate-mcp-registry.mjs')

    expect(() =>
      execFileSync(process.execPath, [resolve('.github/scripts/validate-mcp-registry.mjs')], {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).not.toThrow()
  })

  it('rejects duplicate package entries in the registry manifest validator', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'madar-registry-'))
    const packageManifest = loadPackageManifest()
    const registryManifest = loadRegistryManifest()

    mkdirSync(join(tempRoot, 'docs', 'mcp-registry'), { recursive: true })
    writeFileSync(join(tempRoot, 'package.json'), JSON.stringify(packageManifest, null, 2))
    writeFileSync(
      join(tempRoot, 'docs', 'mcp-registry', 'server.json'),
      JSON.stringify(
        {
          ...registryManifest,
          packages: [...(registryManifest.packages ?? []), ...(registryManifest.packages ?? [])],
        },
        null,
        2,
      ),
    )

    try {
      expect(() =>
        execFileSync(process.execPath, [resolve('.github/scripts/validate-mcp-registry.mjs')], {
          cwd: tempRoot,
          encoding: 'utf8',
          stdio: 'pipe',
        }),
      ).toThrow()
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('documents the public-registry decision, validation command, and local-first trust boundary', () => {
    const reference = readFileSync(resolve('docs/reference/cli-and-mcp.md'), 'utf8')
    const releaseDoc = readFileSync(resolve('docs/release.md'), 'utf8')

    expect(reference).toContain('docs/mcp-registry/server.json')
    expect(reference).toContain('npm run registry:validate')
    expect(reference).toContain('The official MCP Registry hosts metadata, not Madar code or your local graph artifact.')
    expect(reference).toContain('`npx @lubab/madar serve --stdio --auto-refresh`')
    expect(reference).toContain('Private registry usage stays out of scope for the public Madar listing')
    expect(reference).toContain('If you still discover older `graphify-ts` links or listings, Madar is the current project name.')
    expect(reference).toContain('`https://github.com/mohanagy/madar`')
    expect(releaseDoc).toContain('npm run registry:validate')
  })

  it('keeps an OIDC registry-publish workflow behind an explicit release-tag dispatch', () => {
    const workflow = parsePublishWorkflow()
    const releaseTag = workflow.on?.workflow_dispatch?.inputs?.release_tag
    const publish = workflow.jobs?.publish
    const checkout = publishWorkflowStep(workflow, 'Check out released tag')
    const setupNode = publishWorkflowStep(workflow, 'Set up Node.js')
    const verifyTag = publishWorkflowStep(workflow, 'Verify exact release tag')
    const install = publishWorkflowStep(workflow, 'Install dependencies')
    const validate = publishWorkflowStep(workflow, 'Validate registry manifest')
    const installPublisher = publishWorkflowStep(workflow, 'Install MCP Registry publisher')
    const authenticate = publishWorkflowStep(workflow, 'Authenticate to MCP Registry')
    const publishMetadata = publishWorkflowStep(workflow, 'Publish MCP Registry metadata')
    const verifyPublication = publishWorkflowStep(workflow, 'Verify published Registry entry')
    const steps = publish?.steps ?? []
    const indexOf = (step: PublishWorkflowStep) => steps.indexOf(step)

    expect(releaseTag).toMatchObject({ required: true, type: 'string' })
    expect(publish?.permissions).toMatchObject({ contents: 'read', 'id-token': 'write' })
    expect(checkout).toMatchObject({
      uses: 'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0',
      with: {
        ref: 'refs/tags/${{ inputs.release_tag }}',
        'persist-credentials': false,
      },
    })
    expect(setupNode).toMatchObject({
      uses: 'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38',
      with: { 'node-version': '20' },
    })
    expect(verifyTag.run).toContain('git describe --exact-match --tags HEAD')
    expect(install.run).toBe('npm ci --ignore-scripts')
    expect(validate.run).toContain('npm run registry:validate')
    expect(indexOf(verifyTag)).toBeLessThan(indexOf(install))
    expect(indexOf(install)).toBeLessThan(indexOf(validate))
    expect(installPublisher.run).toContain("publisher_version='1.8.0'")
    expect(installPublisher.run).toContain('sha256sum --check -')
    expect(authenticate.run).toBe('./mcp-publisher login github-oidc')
    expect(publishMetadata).toMatchObject({
      'working-directory': 'docs/mcp-registry',
      run: '$GITHUB_WORKSPACE/mcp-publisher publish',
    })
    expect(verifyPublication.run).toContain('registry.modelcontextprotocol.io/v0.1/servers?search=')
    expect(verifyPublication.run).toContain('AbortSignal.timeout(10_000)')
    expect(verifyPublication.run).toContain('for (let attempt = 1; attempt <= attempts; attempt += 1)')
    expect(verifyPublication.run).toContain('entry.server?.name')
  })
})
