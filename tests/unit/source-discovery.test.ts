import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  classifySourceDomain,
  isPollutedSourcePath,
} from '../../src/shared/source-discovery.js'

describe('query source classification', () => {
  const root = resolve('workspace', 'project')

  it('keeps handwritten library source while rejecting top-level build output', () => {
    expect(classifySourceDomain(join(root, 'src', 'lib', 'helper.ts'), root)).toBe('production')
    expect(isPollutedSourcePath(join(root, 'src', 'lib', 'helper.ts'), root)).toBe(false)

    expect(classifySourceDomain(join(root, 'lib', 'index.js'), root)).toBe('build_artifact')
    expect(classifySourceDomain(join(root, 'lib', 'index.d.ts'), root)).toBe('build_artifact')
    expect(isPollutedSourcePath(join(root, 'lib', 'index.js'), root)).toBe(true)
  })

  it('classifies non-production domains without owning filesystem discovery', () => {
    expect(classifySourceDomain(join(root, 'tests', 'auth.test.ts'), root)).toBe('test')
    expect(classifySourceDomain(join(root, 'benchmarks', 'query.bench.ts'), root)).toBe('benchmark')
    expect(classifySourceDomain(join(root, 'fixtures', 'sample.ts'), root)).toBe('fixture')
    expect(classifySourceDomain(join(root, 'generated', 'client.ts'), root)).toBe('generated')
    expect(classifySourceDomain(join(root, 'docs', 'design.md'), root)).toBe('docs')
    expect(classifySourceDomain(join(root, 'tsconfig.json'), root)).toBe('config')
  })

  it('recognizes polluted paths under POSIX and Windows roots', () => {
    expect(isPollutedSourcePath(join(root, 'node_modules', 'pkg', 'index.js'), root)).toBe(true)
    expect(isPollutedSourcePath('D:\\a\\madar\\madar\\out\\graph.json', 'D:\\a\\madar\\madar')).toBe(true)
    expect(isPollutedSourcePath('D:\\a\\madar\\madar\\src\\main.ts', 'D:\\a\\madar\\madar')).toBe(false)
  })
})
