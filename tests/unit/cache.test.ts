import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cacheDir, cachedFiles, clearCache, fileHash, loadCached, saveCached } from '../../src/infrastructure/cache.js'
import { normalizeAssertionPath } from './helpers/platform.js'

describe('cache', () => {
  function createTempRoot(): string {
    return mkdtempSync(join(tmpdir(), 'sadeem-cache-'))
  }

  function createFile(root: string, name: string, content: string): string {
    const path = join(root, name)
    writeFileSync(path, content, 'utf8')
    return path
  }

  it('returns a consistent SHA256 hash for the same file', () => {
    const root = createTempRoot()
    try {
      const filePath = createFile(root, 'sample.txt', 'hello world')

      const hashA = fileHash(filePath)
      const hashB = fileHash(filePath)

      expect(hashA).toBe(hashB)
      expect(typeof hashA).toBe('string')
      expect(hashA).toHaveLength(64)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns different hashes for different file contents', () => {
    const root = createTempRoot()
    try {
      const fileA = createFile(root, 'a.txt', 'content one')
      const fileB = createFile(root, 'b.txt', 'content two')

      expect(fileHash(fileA)).not.toBe(fileHash(fileB))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('includes the resolved path in the hash to avoid identical-content collisions', () => {
    const root = createTempRoot()
    try {
      const fileA = createFile(root, 'a.txt', 'same content')
      const nestedDir = join(root, 'nested')
      mkdirSync(nestedDir, { recursive: true })
      const fileB = createFile(nestedDir, 'b.txt', 'same content')

      expect(fileHash(fileA)).not.toBe(fileHash(fileB))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('creates the out/cache directory if missing', () => {
    const root = createTempRoot()
    try {
      const directory = cacheDir(root)
      expect(existsSync(directory)).toBe(true)
      expect(directory.endsWith(join('out', 'cache'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('saves and loads a cached extraction result', () => {
    const root = createTempRoot()
    try {
      const filePath = createFile(root, 'sample.txt', 'hello world')
      const result = { nodes: [{ id: 'n1', label: 'Node1' }], edges: [] }

      saveCached(filePath, result, root)

      expect(loadCached(filePath, root)).toEqual(result)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns null when file contents change after caching', () => {
    const root = createTempRoot()
    try {
      const filePath = createFile(root, 'sample.txt', 'hello world')
      const result = { nodes: [], edges: [{ source: 'a', target: 'b' }] }

      saveCached(filePath, result, root)
      writeFileSync(filePath, 'completely different content', 'utf8')

      expect(loadCached(filePath, root)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lists all cached file hashes', () => {
    const root = createTempRoot()
    try {
      const fileA = createFile(root, 'file1.py', 'alpha')
      const fileB = createFile(root, 'file2.py', 'beta')

      saveCached(fileA, { nodes: [], edges: [] }, root)
      saveCached(fileB, { nodes: [], edges: [] }, root)

      const hashes = cachedFiles(root)

      expect(hashes).toContain(fileHash(fileA))
      expect(hashes).toContain(fileHash(fileB))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('clears all cache json files', () => {
    const root = createTempRoot()
    try {
      const filePath = createFile(root, 'sample.txt', 'hello world')
      saveCached(filePath, { nodes: [], edges: [] }, root)

      const directory = cacheDir(root)
      expect(normalizeAssertionPath(directory).endsWith('out/cache')).toBe(true)

      clearCache(root)

      expect(cachedFiles(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
