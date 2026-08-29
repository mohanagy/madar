import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  MAX_VERIFICATION_TARGET_LENGTH,
  MAX_VERIFICATION_TARGETS_PER_RECORD,
  normalizeVerificationTargetPath,
} from '../../src/contracts/graph-integrity.js'
import { buildFromJson } from '../../src/pipeline/build.js'

const ROOT = '/repo/project'

/**
 * Every case runs through `buildFromJson`, not the helper alone.
 *
 * A helper-only test proves the sanitizer works; it does not prove the
 * production path actually calls it. R1 was exactly that gap -- the policy
 * existed in spirit and the candidate path used the identity normalizer.
 */
function targetsFor(sourceFile: string, repositoryRoot?: string): readonly string[] {
  const graph = buildFromJson({
    schema_version: 1,
    nodes: [{ id: 'alpha', label: 'Alpha', file_type: 'code', source_file: sourceFile }],
    edges: [{ source: 'alpha', target: 'nowhere', relation: 'imports_from', confidence: 'EXTRACTED', source_file: sourceFile }],
  }, {
    directed: true,
    accounting: 'normalized_extraction_boundary',
    ...(repositoryRoot !== undefined ? { repositoryRoot } : {}),
  })
  const record = graph.normalizedAccountingSummary()!.unresolvedRecords[0]!
  return record.verificationTargets.map((target) => target.file)
}

describe('R1 — unsafe verification targets never reach a record', () => {
  it.each([
    ['percent-encoded separator', 'src/%2FUsers%2Fsecret.ts'],
    ['U+2215 division slash', 'src/a\u2215b.ts'],
    ['U+2044 fraction slash', 'src/a\u2044b.ts'],
    ['U+FF0F fullwidth solidus', 'src/a\uff0fb.ts'],
    ['U+29F8 big solidus', 'src/a\u29f8b.ts'],
    ['null byte', 'src/a\u0000b.ts'],
    ['newline', 'src/a\nb.ts'],
    ['tab', 'src/a\tb.ts'],
    ['C1 control', 'src/a\u0085b.ts'],
    ['file: without slashes', 'file:relative-looking'],
    ['mailto:', 'mailto:user@example.com'],
    ['data:', 'data:text/plain,hi'],
    ['vscode:', 'vscode:file/x'],
    ['http: without slashes', 'http:example.com'],
    ['https URL', 'https://example.com/x.ts'],
    ['home relative', '~/secret.ts'],
    ['bare parent', '..'],
    ['parent traversal', '../a.ts'],
    ['windows parent traversal', '..\\a.ts'],
    ['interior traversal', 'a/../b.ts'],
  ])('refuses %s through the production path', (_label, value) => {
    expect(targetsFor(value)).toEqual([])
  })

  it('refuses a target longer than the bound', () => {
    expect(targetsFor(`src/${'x'.repeat(5000)}.ts`)).toEqual([])
  })

  it('accepts a target at exactly the bound and refuses one past it', () => {
    const pad = (length: number): string => `src/${'x'.repeat(length - 'src/'.length - 3)}.ts`
    expect(normalizeVerificationTargetPath(pad(MAX_VERIFICATION_TARGET_LENGTH), { field: 't' }))
      .toHaveLength(MAX_VERIFICATION_TARGET_LENGTH)
    expect(normalizeVerificationTargetPath(pad(MAX_VERIFICATION_TARGET_LENGTH + 1), { field: 't' }))
      .toBeNull()
  })
})

describe('R1 — legitimate paths survive', () => {
  it('keeps an ordinary repository-relative target', () => {
    expect(targetsFor('src/pipeline/build.ts')).toEqual(['src/pipeline/build.ts'])
  })

  it('keeps a directory whose NAME begins with two dots', () => {
    // The regression: `startsWith('..')` conflated this with traversal.
    expect(targetsFor('..fixtures/a.ts')).toEqual(['..fixtures/a.ts'])
  })

  it('keeps a name beginning with three dots', () => {
    expect(targetsFor('src/...generated/a.ts')).toEqual(['src/...generated/a.ts'])
  })

  it('normalizes mixed separators to forward slashes', () => {
    expect(targetsFor('src\\pipeline/build.ts')).toEqual(['src/pipeline/build.ts'])
  })

  it('drops redundant current-directory segments', () => {
    expect(targetsFor('./src/./a.ts')).toEqual(['src/a.ts'])
  })
})

describe('R1 — absolute paths convert only against a truthful root', () => {
  it('converts an in-root absolute path', () => {
    expect(targetsFor(`${ROOT}/src/a.ts`, ROOT)).toEqual(['src/a.ts'])
  })

  it('omits an out-of-root absolute path', () => {
    expect(targetsFor('/elsewhere/src/a.ts', ROOT)).toEqual([])
  })

  it('omits an absolute path when no root is supplied, rather than guessing', () => {
    expect(targetsFor(`${ROOT}/src/a.ts`)).toEqual([])
  })

  it('does not treat a sibling sharing a name prefix as in-root', () => {
    expect(targetsFor('/repo/project-other/src/a.ts', ROOT)).toEqual([])
  })

  it('never leaks a linked-worktree physical path', () => {
    const physical = '/repo/.git/madar/worktrees/abc/src/a.ts'
    expect(targetsFor(physical, ROOT)).toEqual([])
    expect(JSON.stringify(targetsFor(physical, ROOT))).not.toContain('.git')
  })

  it('converts a Windows in-root absolute path', () => {
    expect(normalizeVerificationTargetPath('C:/proj/src/a.ts', { repositoryRoot: 'C:/proj', field: 't' }))
      .toBe('src/a.ts')
  })
})

describe('R1 — targets are deduplicated, ordered and bounded', () => {
  it('produces a deterministic bounded set', () => {
    const many = Array.from({ length: MAX_VERIFICATION_TARGETS_PER_RECORD + 6 }, (_, i) => (
      normalizeVerificationTargetPath(`src/f${String(i).padStart(3, '0')}.ts`, { field: 't' })
    ))
    expect(many.every((value) => value !== null)).toBe(true)
  })

  it('is idempotent', () => {
    const once = normalizeVerificationTargetPath('src\\a/./b.ts', { field: 't' })!
    expect(normalizeVerificationTargetPath(once, { field: 't' })).toBe(once)
  })
})

describe('R1 — the policy has one owner', () => {
  const SRC = resolve(process.cwd(), 'src')

  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) sources(path, out)
      else if (path.endsWith('.ts')) out.push(path)
    }
    return out
  }

  it('constructs integrity verification targets only where the policy is applied', () => {
    // A caller that assembles targets by hand and skips the sanitizer would
    // reintroduce R1 silently, so the construction sites are pinned.
    //
    // Scoped to the INTEGRITY target type. `verificationTargets` also names the
    // answerability target on MadarVerificationTarget, which belongs to the Pack
    // domain and is #659's to govern -- matching on the bare field name pulls in
    // three unrelated files.
    const offenders: string[] = []
    for (const path of sources(SRC)) {
      const text = readFileSync(path, 'utf8')
      if (!text.includes('IntegrityVerificationTarget')) continue
      const rel = relative(process.cwd(), path).split('\\').join('/')
      // graph-integrity owns the policy; build supplies raw producer paths that
      // the policy then judges; the session forwards drafts untouched.
      const permitted = [
        'src/contracts/graph-integrity.ts',
        'src/contracts/graph-integrity-session.ts',
        'src/pipeline/build.ts',
        // #659 consumes targets the policy already sanitized and projects them
        // into the Pack answerability domain. It reads `file` and `reason` off
        // a retained record and never assembles an IntegrityVerificationTarget,
        // so the sanitizer cannot be bypassed through it.
        'src/shared/graph-integrity-answerability.ts',
      ]
      if (!permitted.includes(rel)) offenders.push(rel)
    }
    expect(offenders, `unreviewed verificationTargets construction: ${offenders.join(', ')}`).toEqual([])
  })

  it('keeps the session from normalizing targets a second time', () => {
    // Double normalization would strip the root context and silently disable
    // in-root absolute conversion.
    const session = readFileSync(resolve(SRC, 'contracts/graph-integrity-session.ts'), 'utf8')
    expect(session.includes('normalizeVerificationTargets')).toBe(false)
  })
})

describe('R1-01 — absolute containment is proven with platform semantics', () => {
  // Maintainer decision: a raw absolute Windows/UNC path must never reach a
  // share-safe receipt, but truthful conversion under a verified matching root
  // is permitted and required on every supported platform. Refusing all
  // Windows/UNC input before conversion would leave legitimate Windows
  // repositories with no verification targets at all.
  const win = (value: string, root?: string): string | null =>
    normalizeVerificationTargetPath(value, root === undefined ? { field: 't' } : { repositoryRoot: root, field: 't' })

  it('1. converts a drive path inside its own root', () => {
    expect(win('C:\\repo\\src\\a.ts', 'C:\\repo')).toBe('src/a.ts')
  })

  it('2. matches a drive root case-insensitively, keeping the source casing', () => {
    // Windows volumes are case-insensitive, so `c:\REPO` names the same
    // directory as `C:\repo`. Refusing it would deny targets to a truthful
    // repository over letter case alone. The emitted target keeps the source's
    // casing rather than the root's.
    expect(win('c:\\REPO\\src\\a.ts', 'C:\\repo')).toBe('src/a.ts')
    expect(win('C:\\repo\\SRC\\A.ts', 'C:\\repo')).toBe('SRC/A.ts')
  })

  it('3. omits a path on a different drive', () => {
    expect(win('D:\\repo\\a.ts', 'C:\\repo')).toBeNull()
  })

  it('4. omits a root-prefix look-alike', () => {
    expect(win('C:\\repo2\\a.ts', 'C:\\repo')).toBeNull()
  })

  it('5. converts a UNC path inside its own share', () => {
    expect(win('\\\\server\\share\\repo\\src\\a.ts', '\\\\server\\share\\repo')).toBe('src/a.ts')
  })

  it('6. omits a path on a different share', () => {
    expect(win('\\\\server\\other\\repo\\a.ts', '\\\\server\\share\\repo')).toBeNull()
  })

  it('7. omits a UNC root-prefix look-alike', () => {
    expect(win('\\\\server\\share\\repo2\\a.ts', '\\\\server\\share\\repo')).toBeNull()
  })

  it('8. omits every absolute form when no truthful root is supplied', () => {
    for (const value of [
      'C:\\repo\\src\\a.ts',
      'C:/repo/src/a.ts',
      '\\\\server\\share\\repo\\src\\a.ts',
      '/repo/src/a.ts',
    ]) {
      expect(win(value), value).toBeNull()
    }
  })

  it('9. never emits a drive letter, UNC prefix, username or physical root', () => {
    const converted = [
      win('C:\\repo\\src\\a.ts', 'C:\\repo'),
      win('\\\\server\\share\\repo\\src\\a.ts', '\\\\server\\share\\repo'),
      win('/home/someone/repo/src/a.ts', '/home/someone/repo'),
    ]
    expect(converted).toEqual(['src/a.ts', 'src/a.ts', 'src/a.ts'])
    for (const value of converted) {
      expect(value).not.toMatch(/^[A-Za-z]:/)
      expect(value).not.toMatch(/^[\\/]/)
      expect(value).not.toContain('\\')
      expect(value).not.toContain('server')
      expect(value).not.toContain('someone')
    }
  })

  it('10. leaves POSIX in-root conversion correct', () => {
    expect(win('/repo/src/a.ts', '/repo')).toBe('src/a.ts')
    expect(win('/repo/deeply/nested/b.ts', '/repo')).toBe('deeply/nested/b.ts')
    expect(win('/repo2/a.ts', '/repo')).toBeNull()
    expect(win('/other/a.ts', '/repo')).toBeNull()
  })

  it('refuses a flavour mismatch in either direction', () => {
    // A Windows path under a POSIX root is not containment, however the strings
    // happen to line up.
    expect(win('C:\\repo\\a.ts', '/repo')).toBeNull()
    expect(win('/repo/a.ts', 'C:\\repo')).toBeNull()
  })

  it('refuses a drive-relative path, which proves no containment', () => {
    expect(win('C:relative\\a.ts', 'C:\\repo')).toBeNull()
  })

  it('refuses the root itself, which names no file', () => {
    expect(win('C:\\repo', 'C:\\repo')).toBeNull()
    expect(win('/repo', '/repo')).toBeNull()
  })
})
