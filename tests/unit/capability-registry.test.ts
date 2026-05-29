import { builtinCapabilities, createBuiltinCapabilityRegistry, createCapabilityRegistry, type CapabilityDefinition } from '../../src/infrastructure/capabilities.js'

describe('builtin capability registry', () => {
  it('resolves python files to the python extractor capability', () => {
    const registry = createBuiltinCapabilityRegistry()

    expect(registry.resolveExtractorForPath('src/auth.py')?.id).toBe('builtin:extract:python')
  })

  it('resolves typescript files to the typescript extractor capability', () => {
    const registry = createBuiltinCapabilityRegistry()

    expect(registry.resolveExtractorForPath('src/auth.ts')?.id).toBe('builtin:extract:typescript')
  })

  it('ships only extract capabilities in the builtin registry', () => {
    const registry = createBuiltinCapabilityRegistry()

    expect(registry.list().every((capability) => capability.kind === 'extract')).toBe(true)
    expect(builtinCapabilities().every((capability) => capability.kind === 'extract')).toBe(true)
  })

  it('rejects duplicate capability registration', () => {
    const registry = createCapabilityRegistry()
    const capability: CapabilityDefinition = {
      id: 'builtin:extract:python',
      kind: 'extract',
      fileType: 'code',
      extensions: ['.py'],
    }

    registry.register(capability)

    expect(() => registry.register(capability)).toThrow(/already registered|duplicate/i)
  })

  it('normalizes extensions during registration and lookup', () => {
    const registry = createCapabilityRegistry([
      {
        id: 'custom:extract:yaml',
        kind: 'extract',
        fileType: 'document',
        extensions: ['yaml'],
      },
    ])

    expect(registry.resolveExtractorForPath('notes.yaml')?.id).toBe('custom:extract:yaml')
    expect(registry.resolveExtractorForPath('.yaml')?.id).toBe('custom:extract:yaml')
  })

  it('rejects duplicate extension claims across capabilities', () => {
    const registry = createCapabilityRegistry([
      {
        id: 'builtin:extract:python',
        kind: 'extract',
        fileType: 'code',
        extensions: ['.py'],
      },
    ])

    expect(() =>
      registry.register({
        id: 'custom:extract:alt-python',
        kind: 'extract',
        fileType: 'code',
        extensions: ['py'],
      }),
    ).toThrow(/already registered/i)
  })

  it('does not expose ingest capability definitions in custom registries', () => {
    const registry = createCapabilityRegistry([
      {
        id: 'custom:extract:yaml',
        kind: 'extract',
        fileType: 'document',
        extensions: ['.yaml'],
      },
    ])

    expect(registry.list()).toEqual([
      {
        id: 'custom:extract:yaml',
        kind: 'extract',
        fileType: 'document',
        extensions: ['.yaml'],
      },
    ])
  })
})
