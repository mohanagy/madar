import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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

    expect(registryManifest.$schema).toContain('static.modelcontextprotocol.io/schemas/')
    expect(registryManifest.name).toBe('io.github.mohanagy/madar')
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
      undefined,
    ])
    expect(graphPathArgument).toMatchObject({
      type: 'positional',
      valueHint: 'graph_path',
      default: 'out/graph.json',
      format: 'filepath',
      isRequired: true,
    })
    expect(graphPathArgument?.description?.toLowerCase()).toContain('madar generate')
    expect(toolProfile).toMatchObject({
      name: 'MADAR_TOOL_PROFILE',
      default: 'core',
    })
    expect(toolProfile?.choices).toEqual(expect.arrayContaining(['core', 'full']))
  })

  it('exposes a repeatable local validation command for the checked-in registry metadata', () => {
    const packageManifest = loadPackageManifest()
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

    expect(packageManifest.scripts?.['registry:validate']).toBeDefined()

    expect(() =>
      execFileSync(npmCommand, ['run', 'registry:validate'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).not.toThrow()
  })

  it('documents the public-registry decision, validation command, and local-first trust boundary', () => {
    const readme = readFileSync(resolve('README.md'), 'utf8')
    const releaseDoc = readFileSync(resolve('docs/release.md'), 'utf8')

    expect(readme).toContain('docs/mcp-registry/server.json')
    expect(readme).toContain('npm run registry:validate')
    expect(readme).toContain('The official MCP Registry hosts metadata, not Madar code or your local graph artifact.')
    expect(readme).toContain('Private registry usage stays out of scope for the public Madar listing')
    expect(releaseDoc).toContain('npm run registry:validate')
  })
})
