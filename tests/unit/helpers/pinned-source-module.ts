import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, normalize } from 'node:path'
import { pathToFileURL } from 'node:url'

import ts from 'typescript'

/**
 * Loads a module tree exactly as it existed at a pinned commit.
 *
 * #658 promises that an artifact carrying normalized accounting still loads in
 * a reader that predates the feature. The only way to prove that is to run the
 * reader that predates it, verbatim. Re-implementing what the old parser "would
 * have done" proves a guess, and a guess about compatibility is worth nothing.
 *
 * The same machinery answers a second question: what a pre-Stage-3 writer
 * actually produced, so the current loader can be tested against real old bytes
 * rather than against bytes the current writer was asked to pretend were old.
 *
 * This mirrors the v0.32.1 old-reader control, which extracts the released
 * loader from its tag and executes it. The difference is scale: that control
 * needed one function, this one needs a module graph, so the closure is walked
 * and transpiled rather than spliced.
 *
 * Identity is asserted, never assumed. Both the commit and a digest over the
 * exact bytes of every file in the closure are pinned; a checkout where either
 * differs fails loudly instead of quietly proving something about other source.
 */

export interface PinnedSourceModule {
  readonly commit: string
  readonly digest: string
  readonly files: readonly string[]
  /** The temporary ESM tree, so a child process can be pointed at it. */
  readonly root: string
  readonly load: <T>(entry: string) => Promise<T>
  readonly dispose: () => void
}

function gitShow(commit: string, path: string): string {
  return execFileSync('git', ['show', `${commit}:${path}`], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
}

/**
 * Walks the relative-import closure of the entry files.
 *
 * Relative specifiers only, which the checked bare-import audit below makes
 * safe: a closure that reached a package would need `node_modules` resolvable
 * from the temporary directory, and silently failing to find one would look
 * like a different module rather than a missing file.
 */
function closure(commit: string, entries: readonly string[]): Map<string, string> {
  return closureFrom((path) => gitShow(commit, path), entries, commit)
}

/**
 * The shared walk, parameterised by where the source comes from.
 *
 * Two callers need the identical traversal over different origins: a pinned
 * commit, read through `git show`, and the working tree, read off disk. Keeping
 * one walker means a change to how specifiers are resolved cannot apply to one
 * caller and silently not the other.
 */
function closureFrom(
  read: (path: string) => string,
  entries: readonly string[],
  origin: string,
): Map<string, string> {
  const sources = new Map<string, string>()
  const queue = [...entries]
  while (queue.length > 0) {
    const path = queue.shift() as string
    if (sources.has(path)) continue
    const source = read(path)
    sources.set(path, source)
    for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
      const specifier = match[1] as string
      if (specifier.startsWith('node:')) continue
      if (!specifier.startsWith('.')) {
        throw new Error(
          `${origin}:${path} imports the package ${JSON.stringify(specifier)}; `
          + 'the pinned closure resolves relative specifiers only',
        )
      }
      queue.push(normalize(join(dirname(path), specifier)).replace(/\.js$/, '.ts'))
    }
  }
  return sources
}

/** A digest over the whole closure, path and content, in a stable order. */
export function closureDigest(sources: ReadonlyMap<string, string>): string {
  const hash = createHash('sha256')
  for (const path of [...sources.keys()].sort()) {
    hash.update(path)
    hash.update('\0')
    hash.update(sources.get(path) as string)
    hash.update('\0')
  }
  return hash.digest('hex')
}

export interface PinnedSourceOptions {
  readonly commit: string
  readonly entries: readonly string[]
  /**
   * The expected closure digest. Required: a control that silently accepts
   * whatever source it finds is not pinned to anything.
   */
  readonly digest: string
}

/**
 * Materializes the pinned closure as runnable ESM in a temporary directory.
 *
 * Transpiled rather than type-checked, deliberately. Type errors against
 * today's `@types/node` say nothing about what the historical code did at
 * runtime, and the runtime behaviour is the entire question.
 */
export function pinnedSourceModule(options: PinnedSourceOptions): PinnedSourceModule {
  const sources = closure(options.commit, options.entries)
  const digest = closureDigest(sources)
  if (digest !== options.digest) {
    throw new Error(
      `pinned closure at ${options.commit} digests ${digest}, not the expected ${options.digest}; `
      + 'the control would otherwise prove something about different source',
    )
  }

  return materialize(sources, options.commit, digest)
}

/** Writes a transpiled closure to a temporary ESM tree and exposes it. */
function materialize(
  sources: ReadonlyMap<string, string>,
  commit: string,
  digest: string,
): PinnedSourceModule {
  const root = mkdtempSync(join(tmpdir(), 'madar-pinned-source-'))
  for (const [path, source] of sources) {
    const target = join(root, path.replace(/\.ts$/, '.js'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        useDefineForClassFields: false,
      },
    }).outputText, 'utf8')
  }
  // ESM by extension: the temporary tree is outside any package, so without
  // this Node reads the .js files as CommonJS and every import fails.
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n', 'utf8')

  return Object.freeze({
    commit,
    digest,
    files: Object.freeze([...sources.keys()].sort()),
    root,
    load: <T>(entry: string): Promise<T> => import(
      pathToFileURL(join(root, entry.replace(/\.ts$/, '.js'))).href
    ) as Promise<T>,
    dispose: (): void => {
      rmSync(root, { recursive: true, force: true })
    },
  })
}

/**
 * The same materialisation, for the source as it stands in the working tree.
 *
 * The locale-determinism control needs to execute today's serializer inside a
 * child process that was started under a different `LC_ALL`, because a host's
 * collation is fixed when the process starts and cannot be changed from inside
 * it. Transpiling the closure to a standalone ESM tree is what makes that child
 * possible; there is no commit to pin, so identity is the working tree itself.
 */
export function workingTreeSourceModule(entries: readonly string[]): PinnedSourceModule {
  const sources = closureFrom(
    (path) => readFileSync(join(process.cwd(), path), 'utf8'),
    entries,
    'working-tree',
  )
  return materialize(sources, 'working-tree', closureDigest(sources))
}
