import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { _loadMadarignore, _isIgnored, classifyFile, collectFreshnessCandidatePaths, countWords, detect, FileType } from '../../src/pipeline/detect.js'
import { normalizeAssertionPath, normalizeAssertionPaths } from './helpers/platform.js'

const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures')

describe('detect', () => {
  function createTempRoot(): string {
    return mkdtempSync(join(tmpdir(), 'madar-detect-'))
  }

  it('classifies only TypeScript and JavaScript as supported code', () => {
    expect(classifyFile('foo.py')).toBeNull()
    expect(classifyFile('bar.ts')).toBe(FileType.CODE)
    expect(classifyFile('component.tsx')).toBe(FileType.CODE)
    expect(classifyFile('script.js')).toBe(FileType.CODE)
    expect(classifyFile('view.jsx')).toBe(FileType.CODE)
    expect(classifyFile('README.md')).toBeNull()
    expect(classifyFile('paper.pdf')).toBeNull()
    expect(classifyFile('archive.zip')).toBeNull()
  })

  it('shares one path-only inventory for supported, unsupported, and compiler-control candidates', () => {
    const root = createTempRoot()
    try {
      mkdirSync(join(root, 'src'))
      writeFileSync(join(root, 'src', 'main.ts'), 'export const main = true\n', 'utf8')
      writeFileSync(join(root, 'README.md'), '# Receipt\n', 'utf8')
      writeFileSync(join(root, 'tsconfig.app.json'), '{}\n', 'utf8')
      const found = collectFreshnessCandidatePaths(root)

      expect(found).toEqual({ supported: ['src/main.ts'], unsupported: ['README.md'], controls: ['tsconfig.app.json'] })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('skips PDFs inside xcassets directories', () => {
    expect(classifyFile('MyApp/Images.xcassets/icon.imageset/icon.pdf')).toBeNull()
    expect(classifyFile('Pods/HXPHPicker/Assets.xcassets/photo.pdf')).toBeNull()
  })

  it('counts words in the sample markdown fixture', () => {
    expect(countWords(join(FIXTURES_DIR, 'sample.md'))).toBeGreaterThan(5)
  })

  it('detects fixture files and warns for a small corpus', () => {
    const result = detect(FIXTURES_DIR)

    expect(result.total_files).toBeGreaterThanOrEqual(2)
    expect(result.files.code.length).toBeGreaterThan(0)
    expect(result.indexing_outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'sample.md', reason: 'unsupported_file_type' }),
    ]))
    expect(result.needs_graph).toBe(false)
    expect(result.warning).not.toBeNull()
  })

  it('warns on large corpora without advertising nonexistent flags or provider costs', () => {
    const root = createTempRoot()
    try {
      for (let index = 0; index < 201; index += 1) {
        writeFileSync(join(root, `source-${index}.ts`), `${'word '.repeat(250)}\n`, 'utf8')
      }

      const result = detect(root)

      expect(result.needs_graph).toBe(true)
      expect(result.warning).toContain('Large corpus:')
      expect(result.warning).not.toContain('--no-semantic')
      expect(result.warning).not.toContain('Claude tokens')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores out artifacts entirely by default', () => {
    const root = createTempRoot()
    try {
      mkdirSync(join(root, 'out', 'memory'), { recursive: true })
      writeFileSync(join(root, 'out', 'memory', 'query_auth.md'), '# Saved query\n', 'utf8')
      writeFileSync(join(root, 'out', 'graph.json'), '{}\n', 'utf8')
      writeFileSync(join(root, 'out', 'GRAPH_REPORT.md'), '# Report\n', 'utf8')

      const result = detect(root)

      expect(result.files.code.some((filePath) => filePath.includes(`${join('out', 'memory')}`))).toBe(false)
      expect(
        Object.values(result.files)
          .flat()
          .some((filePath) => filePath.endsWith('graph.json')),
      ).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('skips hidden files during detection', () => {
    const result = detect(FIXTURES_DIR)
    for (const files of Object.values(result.files)) {
      for (const filePath of files) {
        const fixtureRelativePath = relative(FIXTURES_DIR, filePath)
        expect(fixtureRelativePath.split(/[\\/]/).some((part) => part.startsWith('.'))).toBe(false)
      }
    }
  })

  it('loads madarignore patterns and excludes matching files', () => {
    const root = createTempRoot()
    try {
      writeFileSync(join(root, '.madarignore'), 'vendor/\n*.generated.ts\n', 'utf8')
      mkdirSync(join(root, 'vendor'), { recursive: true })
      writeFileSync(join(root, 'vendor', 'lib.ts'), 'export const x = 1', 'utf8')
      writeFileSync(join(root, 'main.ts'), 'export const main = true', 'utf8')
      writeFileSync(join(root, 'schema.generated.ts'), 'export const generated = true', 'utf8')

      const result = detect(root)

      expect(result.files.code.some((filePath) => filePath.includes('main.ts'))).toBe(true)
      expect(result.files.code.some((filePath) => filePath.includes('vendor'))).toBe(false)
      expect(result.files.code.some((filePath) => filePath.includes('generated'))).toBe(false)
      expect(result.madarignore_patterns).toBe(2)
      expect(result.indexing_outcomes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: 'vendor',
          kind: 'directory',
          status: 'skipped_by_policy',
          reason: 'madarignore',
        }),
        expect.objectContaining({
          path: 'schema.generated.ts',
          kind: 'file',
          status: 'skipped_by_policy',
          reason: 'madarignore',
        }),
      ]))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not treat ordinary files as sensitive just because an ancestor directory contains token-like words', () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-token-root-'))
    try {
      writeFileSync(join(root, 'app.ts'), 'export const value = 1\n', 'utf8')

      const result = detect(root)

      expect(result.files.code.some((filePath) => filePath.endsWith('app.ts'))).toBe(true)
      expect(result.skipped_sensitive).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses a source-aware secret policy and records structured safety exclusions', () => {
    const root = createTempRoot()
    try {
      mkdirSync(join(root, 'src', 'secrets'), { recursive: true })
      mkdirSync(join(root, 'config', 'credentials'), { recursive: true })
      mkdirSync(join(root, '.aws'), { recursive: true })
      writeFileSync(join(root, 'src', 'token.ts'), 'export const issueToken = () => "token"\n', 'utf8')
      writeFileSync(join(root, 'src', 'password-reset-service.ts'), 'export class PasswordResetService {}\n', 'utf8')
      writeFileSync(join(root, 'src', 'password-policy.ts'), 'export const passwordPolicy = {}\n', 'utf8')
      writeFileSync(join(root, 'src', 'secret-manager.ts'), 'export class SecretManager {}\n', 'utf8')
      writeFileSync(join(root, 'src', 'secrets', 'credential-rotation.ts'), 'export const rotate = () => true\n', 'utf8')
      writeFileSync(join(root, 'src', 'secrets', 'README.md'), '# Credential rotation module\n', 'utf8')
      writeFileSync(join(root, '.env.production'), 'API_TOKEN=real-secret\n', 'utf8')
      writeFileSync(join(root, 'id_ed25519'), 'PRIVATE KEY MATERIAL\n', 'utf8')
      writeFileSync(join(root, 'server.pem'), 'PRIVATE KEY MATERIAL\n', 'utf8')
      writeFileSync(join(root, 'server.pem.backup'), 'PRIVATE KEY MATERIAL\n', 'utf8')
      writeFileSync(join(root, 'config', 'credentials.json'), '{"token":"real-secret"}\n', 'utf8')
      writeFileSync(join(root, 'config', 'credentials', 'production.yml'), 'token: real-secret\n', 'utf8')
      writeFileSync(join(root, '.aws', 'credentials'), '[default]\naws_secret_access_key=real-secret\n', 'utf8')

      const result = detect(root)
      const indexedCode = result.files.code.map((filePath) => relative(root, filePath).replaceAll('\\', '/'))

      expect(indexedCode).toEqual(expect.arrayContaining([
        'src/token.ts',
        'src/password-reset-service.ts',
        'src/password-policy.ts',
        'src/secret-manager.ts',
        'src/secrets/credential-rotation.ts',
      ]))
      expect(result.files.code.map((filePath) => relative(root, filePath).replaceAll('\\', '/'))).not.toContain('src/secrets/README.md')
      expect(result.exclusions).toEqual(expect.arrayContaining([
        { path: '.env.production', kind: 'sensitive', reason: 'environment_file' },
        { path: 'id_ed25519', kind: 'sensitive', reason: 'private_key' },
        { path: 'server.pem', kind: 'sensitive', reason: 'private_key' },
        { path: 'server.pem.backup', kind: 'sensitive', reason: 'private_key' },
        { path: 'config/credentials.json', kind: 'sensitive', reason: 'secret_config' },
        { path: 'config/credentials/production.yml', kind: 'sensitive', reason: 'sensitive_directory' },
        { path: '.aws', kind: 'sensitive', reason: 'credential_store' },
        { path: 'src/secrets/README.md', kind: 'sensitive', reason: 'sensitive_directory' },
      ]))
      expect(result.skipped_sensitive).toEqual(expect.arrayContaining([
        '.env.production',
        'id_ed25519',
        'server.pem',
        'config/credentials.json',
        'config/credentials/production.yml',
      ]))
      expect(result.indexing_outcomes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: '.aws',
          kind: 'directory',
          status: 'skipped_by_policy',
          reason: 'credential_store',
        }),
        expect.objectContaining({
          path: 'config/credentials.json',
          kind: 'file',
          status: 'skipped_by_policy',
          reason: 'secret_config',
        }),
        expect.objectContaining({
          path: 'src/secrets/README.md',
          kind: 'file',
          status: 'skipped_by_policy',
          reason: 'sensitive_directory',
        }),
      ]))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('records a broken followed symlink as an unreadable safety exclusion', () => {
    const root = createTempRoot()
    try {
      symlinkSync(join(root, 'missing.ts'), join(root, 'broken.ts'))

      const result = detect(root, { followSymlinks: true })

      expect(result.exclusions).toContainEqual({
        path: 'broken.ts',
        kind: 'unreadable',
        reason: 'unreadable_path',
      })
      expect(result.indexing_outcomes).toContainEqual(expect.objectContaining({
        path: 'broken.ts',
        kind: 'file',
        status: 'failed',
        reason: 'unreadable_path',
      }))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('records unsupported languages, hidden candidates, and git policy exclusions', () => {
    const root = createTempRoot()
    try {
      mkdirSync(join(root, '.internal'), { recursive: true })
      writeFileSync(join(root, '.internal', 'hidden.ts'), 'export const hidden = true\n', 'utf8')
      writeFileSync(join(root, 'legacy.vue'), '<template />\n', 'utf8')
      writeFileSync(join(root, 'visible.ts'), 'export const visible = true\n', 'utf8')

      const result = detect(root, { includedFiles: new Set([join(root, 'legacy.vue')]) })

      expect(result.indexing_outcomes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: '.internal',
          kind: 'directory',
          status: 'skipped_by_policy',
          reason: 'hidden_path',
        }),
        expect.objectContaining({
          path: 'visible.ts',
          status: 'skipped_by_policy',
          reason: 'gitignored',
        }),
        expect.objectContaining({
          path: 'legacy.vue',
          status: 'unsupported',
          reason: 'unsupported_file_type',
        }),
      ]))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('records an unreadable directory and file as failed indexing outcomes', () => {
    if (process.platform === 'win32') {
      return
    }
    const root = createTempRoot()
    const blockedDirectory = join(root, 'blocked')
    const blockedFile = join(root, 'blocked.ts')
    try {
      mkdirSync(blockedDirectory, { recursive: true })
      writeFileSync(join(blockedDirectory, 'nested.ts'), 'export const nested = true\n', 'utf8')
      writeFileSync(blockedFile, 'export const blocked = true\n', 'utf8')
      chmodSync(blockedDirectory, 0o000)
      chmodSync(blockedFile, 0o000)

      const result = detect(root)

      expect(result.indexing_outcomes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: 'blocked',
          kind: 'directory',
          status: 'failed',
          reason: 'unreadable_directory',
        }),
        expect.objectContaining({
          path: 'blocked.ts',
          kind: 'file',
          status: 'failed',
          reason: 'unreadable_path',
        }),
      ]))
    } finally {
      chmodSync(blockedDirectory, 0o700)
      chmodSync(blockedFile, 0o600)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('cannot disguise private key material behind a source-code symlink', () => {
    const root = createTempRoot()
    try {
      writeFileSync(join(root, 'server.pem'), 'PRIVATE KEY MATERIAL\n', 'utf8')
      symlinkSync(join(root, 'server.pem'), join(root, 'safe.ts'))

      const result = detect(root, { followSymlinks: true })

      expect(result.files.code.some((filePath) => filePath.endsWith('safe.ts'))).toBe(false)
      expect(result.exclusions).toEqual(expect.arrayContaining([
        { path: 'server.pem', kind: 'sensitive', reason: 'private_key' },
        { path: 'safe.ts', kind: 'sensitive', reason: 'private_key' },
      ]))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not bypass a sensitive ancestor through a directory symlink alias', () => {
    const root = createTempRoot()
    try {
      mkdirSync(join(root, 'secrets', 'nested'), { recursive: true })
      writeFileSync(join(root, 'secrets', 'nested', 'notes.md'), '# Production credentials\n', 'utf8')
      writeFileSync(join(root, 'secrets', 'rotation.ts'), 'export const rotate = () => true\n', 'utf8')
      symlinkSync(join(root, 'secrets', 'nested'), join(root, 'safe-config'))

      const result = detect(root, { followSymlinks: true })

      expect(result.files.code.some((filePath) => filePath.endsWith('secrets/rotation.ts'))).toBe(true)
      expect(result.files.code.some((filePath) => filePath.includes('safe-config'))).toBe(false)
      expect(result.exclusions).toEqual(expect.arrayContaining([
        { path: 'secrets/nested/notes.md', kind: 'sensitive', reason: 'sensitive_directory' },
        { path: 'safe-config', kind: 'sensitive', reason: 'sensitive_directory' },
      ]))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores comments in madarignore files', () => {
    const root = createTempRoot()
    try {
      writeFileSync(join(root, '.madarignore'), '# comment\n\nmain.ts\n', 'utf8')
      writeFileSync(join(root, 'main.ts'), 'export const main = true', 'utf8')
      writeFileSync(join(root, 'other.ts'), 'export const other = true', 'utf8')

      const result = detect(root)

      expect(result.files.code.some((filePath) => filePath.includes('main.ts'))).toBe(false)
      expect(result.files.code.some((filePath) => filePath.includes('other.ts'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('exposes madarignore helpers for explicit path matching', () => {
    const root = createTempRoot()
    try {
      writeFileSync(join(root, '.madarignore'), 'vendor/\n*.generated.ts\n', 'utf8')
      const patterns = _loadMadarignore(root)

      expect(_isIgnored(join(root, 'vendor', 'lib.ts'), root, patterns)).toBe(true)
      expect(_isIgnored(join(root, 'schema.generated.ts'), root, patterns)).toBe(true)
      expect(_isIgnored(join(root, 'main.ts'), root, patterns)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('preserves gitignore-style segment semantics in madarignore helpers', () => {
    const root = createTempRoot()
    try {
      const srcFile = join(root, 'src', 'main.ts')
      const nestedFile = join(root, 'src', 'nested', 'main.ts')
      const rootFile = join(root, 'index.ts')

      expect(_isIgnored(srcFile, root, ['src/*.ts'])).toBe(true)
      expect(_isIgnored(nestedFile, root, ['src/*.ts'])).toBe(false)
      expect(_isIgnored(rootFile, root, ['**/*.ts'])).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('follows symlinked directories when requested', () => {
    const root = createTempRoot()
    try {
      const realDir = join(root, 'real_lib')
      mkdirSync(realDir, { recursive: true })
      writeFileSync(join(realDir, 'util.ts'), 'export const util = true', 'utf8')
      symlinkSync(realDir, join(root, 'linked_lib'))

      const resultWithoutSymlinks = detect(root)
      const resultWithSymlinks = detect(root, { followSymlinks: true })

      expect(resultWithoutSymlinks.files.code.some((filePath) => filePath.includes('real_lib'))).toBe(true)
      expect(resultWithoutSymlinks.files.code.some((filePath) => filePath.includes('linked_lib'))).toBe(false)
      expect(resultWithSymlinks.files.code.some((filePath) => filePath.includes('linked_lib'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('follows symlinked files when requested', () => {
    const root = createTempRoot()
    try {
      const realFile = join(root, 'real.ts')
      writeFileSync(realFile, 'x = 1', 'utf8')
      symlinkSync(realFile, join(root, 'link.ts'))

      const result = detect(root, { followSymlinks: true })

      expect(result.files.code.some((filePath) => filePath.includes('real.ts'))).toBe(true)
      expect(result.files.code.some((filePath) => filePath.includes('link.ts'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('handles circular symlinks safely', () => {
    const root = createTempRoot()
    try {
      const subDir = join(root, 'a')
      mkdirSync(subDir, { recursive: true })
      writeFileSync(join(subDir, 'main.ts'), 'export const main = true', 'utf8')
      symlinkSync(root, join(subDir, 'loop'))

      const result = detect(root, { followSymlinks: true })

      expect(result.files.code.some((filePath) => filePath.includes('main.ts'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  describe('noise filtering', () => {
    const noiseDirs = [
      'coverage', '.nyc_output',
      'storybook-static',
    ]

    for (const dir of noiseDirs) {
      it(`skips directory named "${dir}"`, () => {
        const root = createTempRoot()
        try {
          mkdirSync(join(root, dir), { recursive: true })
          writeFileSync(join(root, dir, 'index.ts'), 'export {}', 'utf8')
          writeFileSync(join(root, 'real.ts'), 'export {}', 'utf8')

          const result = detect(root)

          expect(result.files.code.some((f) => f.includes(`/${dir}/`))).toBe(false)
          expect(result.files.code.some((f) => f.endsWith('real.ts'))).toBe(true)
        } finally {
          rmSync(root, { recursive: true, force: true })
        }
      })
    }

    it('indexes *.test.ts files even outside test dirs', () => {
      const root = createTempRoot()
      try {
        writeFileSync(join(root, 'util.test.ts'), 'export {}', 'utf8')
        writeFileSync(join(root, 'util.ts'), 'export {}', 'utf8')

        const result = detect(root)

        expect(result.files.code.some((f) => f.endsWith('util.test.ts'))).toBe(true)
        expect(result.files.code.some((f) => f.endsWith('util.ts'))).toBe(true)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('indexes *.spec.tsx files', () => {
      const root = createTempRoot()
      try {
        writeFileSync(join(root, 'Button.spec.tsx'), 'export {}', 'utf8')
        writeFileSync(join(root, 'Button.tsx'), 'export {}', 'utf8')

        const result = detect(root)

        expect(result.files.code.some((f) => f.endsWith('Button.spec.tsx'))).toBe(true)
        expect(result.files.code.some((f) => f.endsWith('Button.tsx'))).toBe(true)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('excludes *.stories.tsx files', () => {
      const root = createTempRoot()
      try {
        writeFileSync(join(root, 'Button.stories.tsx'), 'export {}', 'utf8')
        writeFileSync(join(root, 'Button.tsx'), 'export {}', 'utf8')

        const result = detect(root)

        expect(result.files.code.some((f) => f.endsWith('Button.stories.tsx'))).toBe(false)
        expect(result.files.code.some((f) => f.endsWith('Button.tsx'))).toBe(true)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('indexes vitest.config.ts', () => {
      const root = createTempRoot()
      try {
        writeFileSync(join(root, 'vitest.config.ts'), 'export default {}', 'utf8')
        writeFileSync(join(root, 'real.ts'), 'export {}', 'utf8')

        const result = detect(root)

        expect(result.files.code.some((f) => f.endsWith('vitest.config.ts'))).toBe(true)
        expect(result.files.code.some((f) => f.endsWith('real.ts'))).toBe(true)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('indexes jest.config.js', () => {
      const root = createTempRoot()
      try {
        writeFileSync(join(root, 'jest.config.js'), 'module.exports = {}', 'utf8')
        writeFileSync(join(root, 'real.ts'), 'export {}', 'utf8')

        const result = detect(root)

        expect(result.files.code.some((f) => f.endsWith('jest.config.js'))).toBe(true)
        expect(result.files.code.some((f) => f.endsWith('real.ts'))).toBe(true)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('does NOT exclude test-utils.ts (only name starts with test-, not test.)', () => {
      const root = createTempRoot()
      try {
        writeFileSync(join(root, 'test-utils.ts'), 'export {}', 'utf8')

        const result = detect(root)

        expect(result.files.code.some((f) => f.endsWith('test-utils.ts'))).toBe(true)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('indexes setupTests.ts', () => {
      const root = createTempRoot()
      try {
        writeFileSync(join(root, 'setupTests.ts'), 'export {}', 'utf8')
        writeFileSync(join(root, 'real.ts'), 'export {}', 'utf8')

        const result = detect(root)

        expect(result.files.code.some((f) => f.endsWith('setupTests.ts'))).toBe(true)
        expect(result.files.code.some((f) => f.endsWith('real.ts'))).toBe(true)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('indexes *.mock.ts files', () => {
      const root = createTempRoot()
      try {
        writeFileSync(join(root, 'api.mock.ts'), 'export {}', 'utf8')
        writeFileSync(join(root, 'api.ts'), 'export {}', 'utf8')

        const result = detect(root)

        expect(result.files.code.some((f) => f.endsWith('api.mock.ts'))).toBe(true)
        expect(result.files.code.some((f) => f.endsWith('api.ts'))).toBe(true)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('indexes jest.setup.ts', () => {
      const root = createTempRoot()
      try {
        writeFileSync(join(root, 'jest.setup.ts'), 'export {}', 'utf8')
        writeFileSync(join(root, 'real.ts'), 'export {}', 'utf8')

        const result = detect(root)

        expect(result.files.code.some((f) => f.endsWith('jest.setup.ts'))).toBe(true)
        expect(result.files.code.some((f) => f.endsWith('real.ts'))).toBe(true)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  })

  it('hard-ignores nested worktrees, out artifacts, and build outputs but keeps tests and benchmarks', () => {
    const root = createTempRoot()
    try {
      mkdirSync(join(root, 'backend', '.worktrees', 'copy', 'src'), { recursive: true })
      mkdirSync(join(root, 'out'), { recursive: true })
      mkdirSync(join(root, 'dist'), { recursive: true })
      mkdirSync(join(root, 'src', '__tests__'), { recursive: true })
      mkdirSync(join(root, 'benchmarks'), { recursive: true })
      writeFileSync(join(root, 'backend', '.worktrees', 'copy', 'src', 'foo.ts'), 'export const stale = true', 'utf8')
      writeFileSync(join(root, 'out', 'graph.json'), '{}', 'utf8')
      writeFileSync(join(root, 'dist', 'compiled.js'), 'module.exports = 1', 'utf8')
      writeFileSync(join(root, 'src', '__tests__', 'foo.spec.ts'), 'export {}', 'utf8')
      writeFileSync(join(root, 'benchmarks', 'report.bench.ts'), 'export {}', 'utf8')

      const result = detect(root)
      const codePaths = normalizeAssertionPaths(result.files.code)

      expect(codePaths.some((filePath) => filePath.includes('/.worktrees/'))).toBe(false)
      expect(codePaths.some((filePath) => filePath.endsWith('/out/graph.json'))).toBe(false)
      expect(codePaths.some((filePath) => filePath.endsWith('/dist/compiled.js'))).toBe(false)
      expect(codePaths).toContain(normalizeAssertionPath(join(root, 'src', '__tests__', 'foo.spec.ts')))
      expect(codePaths).toContain(normalizeAssertionPath(join(root, 'benchmarks', 'report.bench.ts')))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
