import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

interface PackageManifest {
  name?: string
  scripts?: Record<string, string>
  version?: string
}

interface RegistryEnvironmentVariable {
  name?: string
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

function loadPackageManifest(): PackageManifest {
  return JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as PackageManifest
}

function loadRegistryManifest(): RegistryManifest {
  return JSON.parse(readFileSync(resolve('docs/mcp-registry/server.json'), 'utf8')) as RegistryManifest
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
    expect(toolProfile?.choices).toEqual(expect.arrayContaining(['core', 'full']))
    expect(publisherNotes?.source).toBe('docs/mcp-registry/server.json')
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
})
