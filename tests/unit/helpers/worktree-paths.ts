import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'

/**
 * One comparator for "is this the main worktree?", for every platform.
 *
 * Two suites carried byte-identical copies of a filter that compared
 * `realpathSync(path) !== main` as raw strings. That holds on POSIX and fails
 * on Windows for three independent reasons, all of which CI reported:
 *
 *   - `git worktree list --porcelain` prints forward slashes, while
 *     `realpathSync` returns backslashes, so the same directory compares
 *     unequal;
 *   - the drive letter's case is not stable between the two sources, and
 *     Windows paths are case-insensitive, so `C:\x` and `c:\x` are one
 *     directory that compared as two;
 *   - `realpathSync` can return an extended-length `\\?\` prefix that git
 *     never emits.
 *
 * The main worktree was therefore never excluded, and the assertions that
 * expected one worktree saw two and expected none saw one.
 *
 * Duplicating the fix would leave two copies free to drift apart again, which
 * is how the defect reached two files in the first place, so this is the only
 * definition and both suites import it.
 */

/** True where path comparison is case-insensitive and separator-agnostic. */
const isWindows = process.platform === 'win32'

/**
 * Reduces a path to the form two sources can be compared in.
 *
 * Deliberately does NOT lowercase on POSIX: `/tmp/Repo` and `/tmp/repo` are
 * genuinely different directories there, and folding them would make the
 * filter exclude a real worktree.
 */
export function canonicalPathKey(path: string): string {
  let key = path
  // Extended-length prefix, which `realpathSync` may add and git never emits.
  if (key.startsWith('\\\\?\\')) key = key.slice('\\\\?\\'.length)
  // Git porcelain reports forward slashes on every platform.
  if (isWindows) key = key.replace(/\\/g, '/')
  // A trailing separator names the same directory; the root itself keeps its.
  key = key.replace(/(?<=.)\/+$/, '')
  // Windows is case-insensitive, including the drive letter.
  return isWindows ? key.toLowerCase() : key
}

/** Resolves through symlinks where possible, and reports the path as given otherwise. */
function resolved(path: string): string {
  try {
    // `.native` matters on Windows: the runner's temp directory is reported in
    // 8.3 short form (`C:\Users\RUNNER~1\...`) by one source and in long form
    // by the other, and those normalise to different keys. The native resolver
    // returns the canonical long spelling for both. On POSIX it behaves as
    // `realpathSync` does, so this is one call for every platform.
    //
    // On macOS the temp root is a symlink and git reports the resolved path,
    // so resolving at all is required rather than defensive.
    return realpathSync.native(path)
  } catch {
    // A worktree directory that has already been removed is still listed by
    // git until it is pruned. Comparing the raw path is the honest fallback:
    // it cannot be the main worktree, which by definition still exists.
    return path
  }
}

/** True when the two paths name the same directory on this platform. */
export function samePath(left: string, right: string): boolean {
  return canonicalPathKey(resolved(left)) === canonicalPathKey(resolved(right))
}

/** Every worktree git lists for `root`, excluding the main worktree itself. */
export function worktreePaths(root: string): string[] {
  return execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
    .filter((path) => path.length > 0 && !samePath(path, root))
}
