import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  MAX_FETCH_BYTES,
  MAX_TEXT_BYTES,
  safeFetch,
  safeFetchText,
  sanitizeLabel,
  validateGraphOutputPath,
  validateGraphPath,
  validateUrl,
} from '../../src/shared/security.js'

function withTempDir(callback: (tempDir: string) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'sadeem-security-'))
  try {
    callback(tempDir)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('validateUrl', () => {
  test('accepts http urls', () => {
    expect(validateUrl('http://example.com/page')).toBe('http://example.com/page')
  })

  test('accepts https urls', () => {
    expect(validateUrl('https://arxiv.org/abs/1706.03762')).toBe('https://arxiv.org/abs/1706.03762')
  })

  test('rejects file urls', () => {
    expect(() => validateUrl('file:///etc/passwd')).toThrow(/file/i)
  })

  test('rejects ftp urls', () => {
    expect(() => validateUrl('ftp://files.example.com/data.zip')).toThrow(/ftp/i)
  })

  test('rejects data urls', () => {
    expect(() => validateUrl('data:text/html,<script>alert(1)</script>')).toThrow(/data/i)
  })

  test('rejects urls without a scheme', () => {
    expect(() => validateUrl('//no-scheme.example.com')).toThrow()
  })

  test('blocks localhost and cloud metadata hosts', () => {
    expect(() => validateUrl('http://localhost:8080/admin')).toThrow(/private|metadata/i)
    expect(() => validateUrl('http://metadata.google.internal/compute')).toThrow(/metadata/i)
  })
})

describe('safeFetch', () => {
  test('rejects disallowed schemes before fetching', async () => {
    await expect(safeFetch('file:///etc/passwd')).rejects.toThrow(/file/i)
  })

  test('returns response bytes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('hello world', { status: 200 })),
    )
    const bytes = await safeFetch('https://example.com/')
    expect(new TextDecoder().decode(bytes)).toBe('hello world')
  })

  test('raises on non-2xx responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Not Found', { status: 404 })),
    )
    await expect(safeFetch('https://example.com/missing')).rejects.toThrow(/404/)
  })

  test('raises when the payload exceeds the size limit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(65_537).fill(120), { status: 200 })),
    )
    await expect(safeFetch('https://example.com/huge', 65_536)).rejects.toThrow(/size limit/i)
  })

  test('validates redirect targets', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://metadata.google.internal/evil' } })),
    )
    await expect(safeFetch('https://example.com/start')).rejects.toThrow(/metadata/i)
  })
})

describe('safeFetchText', () => {
  test('decodes utf-8 text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('héllo wörld', { status: 200 })),
    )
    await expect(safeFetchText('https://example.com/', MAX_TEXT_BYTES)).resolves.toBe('héllo wörld')
  })

  test('replaces bad bytes when decoding', async () => {
    const bytes = Uint8Array.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0xff, 0x20, 0x77, 0x6f, 0x72, 0x6c, 0x64])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(bytes, { status: 200 })),
    )
    const text = await safeFetchText('https://example.com/', MAX_TEXT_BYTES)
    expect(text).toContain('hello')
    expect(text).toContain('world')
  })
})

describe('validateGraphPath', () => {
  test('allows paths inside the base directory', () => {
    withTempDir((tempDir) => {
      const base = join(tempDir, 'out')
      const graphPath = join(base, 'graph.json')
      mkdirSync(base, { recursive: true })
      writeFileSync(graphPath, '{}\n', 'utf8')
      expect(validateGraphPath(graphPath, base)).toBe(realpathSync(graphPath))
    })
  })

  test('blocks traversal outside the base directory', () => {
    withTempDir((tempDir) => {
      const base = join(tempDir, 'out')
      mkdirSync(base, { recursive: true })
      const evil = join(base, '..', 'etc_passwd')
      expect(() => validateGraphPath(evil, base)).toThrow(/escapes/i)
    })
  })

  test('requires the base directory to exist', () => {
    withTempDir((tempDir) => {
      const base = join(tempDir, 'out')
      expect(() => validateGraphPath(join(base, 'graph.json'), base)).toThrow(/does not exist/i)
    })
  })

  test('raises when the graph file is missing', () => {
    withTempDir((tempDir) => {
      const base = join(tempDir, 'out')
      mkdirSync(base, { recursive: true })
      expect(() => validateGraphPath(join(base, 'missing.json'), base)).toThrow(/not found/i)
    })
  })
})

describe('validateGraphOutputPath', () => {
  test('blocks symlink ancestors that escape the base directory', () => {
    const sandboxRoot = resolve('out', 'test-runtime', 'security-output-symlink')
    const base = resolve(sandboxRoot, 'out')
    const outside = resolve(sandboxRoot, 'outside')

    rmSync(sandboxRoot, { recursive: true, force: true })
    mkdirSync(base, { recursive: true })
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, resolve(base, 'link'), 'dir')

    try {
      expect(() => validateGraphOutputPath(resolve(base, 'link', 'new-run'), base)).toThrow(/escapes/i)
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true })
    }
  })

  test('blocks symlinked base directories', () => {
    const sandboxRoot = resolve('out', 'test-runtime', 'security-output-base-symlink')
    const base = resolve(sandboxRoot, 'out')
    const outside = resolve(sandboxRoot, 'outside')

    rmSync(sandboxRoot, { recursive: true, force: true })
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, base, 'dir')

    try {
      expect(() => validateGraphOutputPath(resolve(base, 'compare'), base)).toThrow(/escapes/i)
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true })
    }
  })

  test.runIf(process.platform !== 'win32')('allows out paths inside a symlinked checkout', () => {
    const sandboxRoot = resolve('out', 'test-runtime', 'security-output-symlinked-checkout')
    const realCheckout = resolve(sandboxRoot, 'real-checkout')
    const symlinkCheckout = resolve(sandboxRoot, 'linked-checkout')
    const base = resolve(symlinkCheckout, 'out')

    rmSync(sandboxRoot, { recursive: true, force: true })
    mkdirSync(resolve(realCheckout, 'out'), { recursive: true })
    symlinkSync(realCheckout, symlinkCheckout, 'dir')

    try {
      expect(validateGraphOutputPath(resolve(base, 'compare'), base)).toBe(resolve(base, 'compare'))
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true })
    }
  })
})

describe('sanitizeLabel', () => {
  test('preserves html characters', () => {
    expect(sanitizeLabel('<script>')).toBe('<script>')
    expect(sanitizeLabel('foo & bar')).toBe('foo & bar')
  })

  test('strips control characters', () => {
    const result = sanitizeLabel('hello\u0000\u001fworld')
    expect(result).toContain('helloworld')
    expect(result).not.toContain('\u0000')
  })

  test('caps labels at 256 characters', () => {
    expect(sanitizeLabel('a'.repeat(300))).toHaveLength(256)
  })
})
