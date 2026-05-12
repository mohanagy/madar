import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { _loadGraphifyignore, _isIgnored, classifyFile, countWords, detect, FileType } from '../../src/pipeline/detect.js'
import { normalizeAssertionPath, normalizeAssertionPaths } from './helpers/platform.js'

const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures')

describe('detect', () => {
  function createTempRoot(): string {
    return mkdtempSync(join(tmpdir(), 'graphify-ts-detect-'))
  }

  it('classifies code, docs, papers, images, audio, video, and unknown files', () => {
    expect(classifyFile('foo.py')).toBe(FileType.CODE)
    expect(classifyFile('bar.ts')).toBe(FileType.CODE)
    expect(classifyFile('README.md')).toBe(FileType.DOCUMENT)
    expect(classifyFile('paper.pdf')).toBe(FileType.PAPER)
    expect(classifyFile('screenshot.png')).toBe(FileType.IMAGE)
    expect(classifyFile('episode.mp3')).toBe(FileType.AUDIO)
    expect(classifyFile('demo.mp4')).toBe(FileType.VIDEO)
    expect(classifyFile('archive.zip')).toBeNull()
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
    expect(result.files.document.length).toBeGreaterThan(0)
    expect(result.needs_graph).toBe(false)
    expect(result.warning).not.toBeNull()
  })

  it('warns on large corpora without advertising nonexistent flags or provider costs', () => {
    const root = createTempRoot()
    try {
      for (let index = 0; index < 201; index += 1) {
        writeFileSync(join(root, `doc-${index}.md`), `${'word '.repeat(250)}\n`, 'utf8')
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

  it('ignores graphify-out artifacts entirely by default', () => {
    const root = createTempRoot()
    try {
      mkdirSync(join(root, 'graphify-out', 'memory'), { recursive: true })
      writeFileSync(join(root, 'graphify-out', 'memory', 'query_auth.md'), '# Saved query\n', 'utf8')
      writeFileSync(join(root, 'graphify-out', 'graph.json'), '{}\n', 'utf8')
      writeFileSync(join(root, 'graphify-out', 'GRAPH_REPORT.md'), '# Report\n', 'utf8')

      const result = detect(root)

      expect(normalizeAssertionPaths(result.files.document)).not.toContain(normalizeAssertionPath(join(root, 'graphify-out', 'memory', 'query_auth.md')))
      expect(result.files.document.some((filePath) => filePath.endsWith('GRAPH_REPORT.md'))).toBe(false)
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

  it('loads graphifyignore patterns and excludes matching files', () => {
    const root = createTempRoot()
    try {
      writeFileSync(join(root, '.graphifyignore'), 'vendor/\n*.generated.py\n', 'utf8')
      mkdirSync(join(root, 'vendor'), { recursive: true })
      writeFileSync(join(root, 'vendor', 'lib.py'), 'x = 1', 'utf8')
      writeFileSync(join(root, 'main.py'), 'print("hi")', 'utf8')
      writeFileSync(join(root, 'schema.generated.py'), 'x = 1', 'utf8')

      const result = detect(root)

      expect(result.files.code.some((filePath) => filePath.includes('main.py'))).toBe(true)
      expect(result.files.code.some((filePath) => filePath.includes('vendor'))).toBe(false)
      expect(result.files.code.some((filePath) => filePath.includes('generated'))).toBe(false)
      expect(result.graphifyignore_patterns).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores comments in graphifyignore files', () => {
    const root = createTempRoot()
    try {
      writeFileSync(join(root, '.graphifyignore'), '# comment\n\nmain.py\n', 'utf8')
      writeFileSync(join(root, 'main.py'), 'x = 1', 'utf8')
      writeFileSync(join(root, 'other.py'), 'x = 2', 'utf8')

      const result = detect(root)

      expect(result.files.code.some((filePath) => filePath.includes('main.py'))).toBe(false)
      expect(result.files.code.some((filePath) => filePath.includes('other.py'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('exposes graphifyignore helpers for explicit path matching', () => {
    const root = createTempRoot()
    try {
      writeFileSync(join(root, '.graphifyignore'), 'vendor/\n*.generated.py\n', 'utf8')
      const patterns = _loadGraphifyignore(root)

      expect(_isIgnored(join(root, 'vendor', 'lib.py'), root, patterns)).toBe(true)
      expect(_isIgnored(join(root, 'schema.generated.py'), root, patterns)).toBe(true)
      expect(_isIgnored(join(root, 'main.py'), root, patterns)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('preserves gitignore-style segment semantics in graphifyignore helpers', () => {
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
      writeFileSync(join(realDir, 'util.py'), 'x = 1', 'utf8')
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
      const realFile = join(root, 'real.py')
      writeFileSync(realFile, 'x = 1', 'utf8')
      symlinkSync(realFile, join(root, 'link.py'))

      const result = detect(root, { followSymlinks: true })

      expect(result.files.code.some((filePath) => filePath.includes('real.py'))).toBe(true)
      expect(result.files.code.some((filePath) => filePath.includes('link.py'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('handles circular symlinks safely', () => {
    const root = createTempRoot()
    try {
      const subDir = join(root, 'a')
      mkdirSync(subDir, { recursive: true })
      writeFileSync(join(subDir, 'main.py'), 'x = 1', 'utf8')
      symlinkSync(root, join(subDir, 'loop'))

      const result = detect(root, { followSymlinks: true })

      expect(result.files.code.some((filePath) => filePath.includes('main.py'))).toBe(true)
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

  it('hard-ignores nested worktrees, graphify-out artifacts, and build outputs but keeps tests and benchmarks', () => {
    const root = createTempRoot()
    try {
      mkdirSync(join(root, 'backend', '.worktrees', 'copy', 'src'), { recursive: true })
      mkdirSync(join(root, 'graphify-out'), { recursive: true })
      mkdirSync(join(root, 'dist'), { recursive: true })
      mkdirSync(join(root, 'src', '__tests__'), { recursive: true })
      mkdirSync(join(root, 'benchmarks'), { recursive: true })
      writeFileSync(join(root, 'backend', '.worktrees', 'copy', 'src', 'foo.ts'), 'export const stale = true', 'utf8')
      writeFileSync(join(root, 'graphify-out', 'graph.json'), '{}', 'utf8')
      writeFileSync(join(root, 'dist', 'compiled.js'), 'module.exports = 1', 'utf8')
      writeFileSync(join(root, 'src', '__tests__', 'foo.spec.ts'), 'export {}', 'utf8')
      writeFileSync(join(root, 'benchmarks', 'report.bench.ts'), 'export {}', 'utf8')

      const result = detect(root)
      const codePaths = normalizeAssertionPaths(result.files.code)

      expect(codePaths.some((filePath) => filePath.includes('/.worktrees/'))).toBe(false)
      expect(codePaths.some((filePath) => filePath.endsWith('/graphify-out/graph.json'))).toBe(false)
      expect(codePaths.some((filePath) => filePath.endsWith('/dist/compiled.js'))).toBe(false)
      expect(codePaths).toContain(normalizeAssertionPath(join(root, 'src', '__tests__', 'foo.spec.ts')))
      expect(codePaths).toContain(normalizeAssertionPath(join(root, 'benchmarks', 'report.bench.ts')))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
